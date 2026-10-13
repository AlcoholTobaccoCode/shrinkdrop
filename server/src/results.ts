import { readFile, stat } from 'node:fs/promises';
import { createReadStream, type ReadStream } from 'node:fs';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { basename, extname } from 'node:path';
import { Zip, ZipPassThrough } from 'fflate';
import type { JobRow, Store } from './store';
import { AppError } from './errors';
//#region 下载结果与归档
const extensions: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/avif': '.avif' };
export function resultName(job: JobRow): string {
    let name = job.source.kind === 'upload' ? job.source.filename : new URL(job.source.url).pathname.split('/').pop() || 'image';
    if (job.source.kind === 'url') {
        try { name = decodeURIComponent(name); }
        catch { }
    }
    name = basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').replace(/^\.+/, '').slice(0, 200) || 'image';
    const ext = extname(name);
    const wanted = extensions[job.result?.mime ?? ''];
    if (wanted && (!ext || extensions[job.input?.mime ?? ''] !== wanted))
        name = name.slice(0, ext ? -ext.length : undefined) + wanted;
    return name;
}
export function contentDisposition(name: string): string {
    const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
export async function readResult(store: Store, job: JobRow): Promise<Buffer> {
    if (job.status === 'canceled' || !job.result || !job.resultFile)
        throw new AppError('INVALID_STATE', '图片尚未处理完成');
    try {
        return await readFile(store.filePath(job.resultFile));
    }
    catch {
        throw new AppError('OUTPUT_FAILED', '结果文件不可用，请重新处理', { retryable: false });
    }
}
export async function createArchive(store: Store, jobs: JobRow[]): Promise<PassThrough> {
    const eligible = jobs.filter(j => j.status !== 'canceled' && j.result && j.resultFile);
    if (!eligible.length)
        throw new AppError('INVALID_STATE', '还没有可以下载的处理结果');
    const entries: Array<{job: JobRow; name: string}> = [];
    const used = new Set<string>();
    for (const job of eligible) {
        const name = resultName(job);
        const ext = extname(name);
        const stem = ext ? name.slice(0, -ext.length) : name;
        let unique = name;
        let i = 2;
        while (used.has(unique.toLocaleLowerCase()))
            unique = `${stem} (${i++})${ext}`;
        used.add(unique.toLocaleLowerCase());
        // 先核对所有结果可用，避免已知缺失文件在响应开始后才失败。
        try { if (!(await stat(store.filePath(job.resultFile!))).isFile()) throw new Error('result unavailable'); }
        catch { throw new AppError('OUTPUT_FAILED', '结果文件不可用，请重新处理', { retryable: false }); }
        entries.push({job, name: unique});
    }
    const output = new PassThrough({highWaterMark: 64 * 1024});
    const controller = new AbortController();
    let activeFile: ReadStream | undefined;
    let zip: Zip | undefined;
    output.once('close', () => { controller.abort(); activeFile?.destroy(); zip?.terminate(); });
    const produce = async () => {
        const chunks: Uint8Array[] = [];
        let zipError: Error | undefined;
        zip = new Zip((error, data) => { if (error) zipError = error; else if (data) chunks.push(data); });
        const flush = async () => {
            if (zipError) throw zipError;
            while (chunks.length) {
                controller.signal.throwIfAborted();
                if (!output.write(chunks.shift()!)) await once(output, 'drain', {signal: controller.signal});
            }
        };
        try {
            for (const {job, name} of entries) {
                controller.signal.throwIfAborted();
                const entry = new ZipPassThrough(name);
                zip.add(entry);
                await flush();
                activeFile = createReadStream(store.filePath(job.resultFile!), {highWaterMark: 64 * 1024, signal: controller.signal});
                for await (const chunk of activeFile) { controller.signal.throwIfAborted(); entry.push(chunk); await flush(); }
                activeFile = undefined;
                entry.push(new Uint8Array(), true);
                await flush();
            }
            zip.end();
            await flush();
            output.end();
        } finally { activeFile?.destroy(); zip.terminate(); }
    };
    // 逐块写入并等待背压，不把整批结果读进内存；断线会中断当前文件和后续文件读取。
    void produce().catch(() => { if (!output.destroyed) output.destroy(new AppError('OUTPUT_FAILED', '结果打包中断，请重试下载', {retryable: true})); });
    return output;
}
//#endregion
