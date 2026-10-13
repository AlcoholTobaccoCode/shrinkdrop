import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { LocalExecutor } from '../../src/core/local/local-executor';
import type { FileAdapter, SourceFile } from '../../src/core/files/contracts';
import type { Executor } from '../../src/core/workbench/executor';
import { createTauriFileAdapter, type TauriInvoke } from '../../src/platform/tauri/file-adapter';

const file = (id: string): SourceFile => ({ id, name: 'hero.png', size: 4, mime: 'image/png', relativePath: 'folder/hero.png' });
const adapter: FileAdapter = {
  chooseFiles: async () => [], chooseDirectory: async () => [], read: async () => new Uint8Array([1, 2, 3, 4]),
  writeTemp: async (id, bytes, ext, mime) => ({ id, name: `${id}.${ext}`, size: bytes.length, mime, relativePath: id }),
  cleanup: async () => undefined, copyToClipboard: async () => undefined, replaceOriginal: async () => undefined
};
const pipeline = { providerId: 'local', operations: [{ type: 'compress' as const }], destinations: [{ type: 'download' as const }] };

describe('D7 本地 zip 下载', () => {
  it('只包含已成功输出的结果，转换扩展名、重名不覆盖，未开始和失败图片不包含', async () => {
    let calls = 0;
    const exec: Executor = new LocalExecutor({ adapter, pipeline, provider: {
      process: async (bytes) => {
        if (++calls === 3) throw new Error('bad image');
        return { bytes: bytes.slice(0, 2), size: 2, mime: 'image/webp', width: 1, height: 1, ratio: 0.5 };
      }
    } });
    exec.addFiles([file('a'), file('b'), file('bad')]);
    await exec.start();
    exec.addFiles([file('draft')]);
    expect(exec.downloadArchive).toBeTypeOf('function');
    if (!exec.downloadArchive) return;
    const archive = await exec.downloadArchive();
    const files = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()));
    expect(Object.keys(files)).toEqual(['hero.webp', 'hero (2).webp']);
    expect(files['hero.webp']).toEqual(new Uint8Array([1, 2]));
    expect(archive.blob.type).toBe('application/zip');
    expect(archive.filename).toMatch(/\.zip$/);
    expect(calls).toBe(3);
    await exec.dispose();
  });

  it('取消打包不改任务状态或再次调用 Provider', async () => {
    const exec: Executor = new LocalExecutor({ adapter, pipeline });
    exec.addFiles([file('a')]);
    const controller = new AbortController();
    controller.abort();
    expect(exec.downloadArchive).toBeTypeOf('function');
    if (!exec.downloadArchive) return;
    await expect(exec.downloadArchive(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect((exec as LocalExecutor).items[0]?.status).toBe('draft');
    await exec.dispose();
  });
});

describe('D8 Tauri 下载保存合同', () => {
  it('复用 opaque 临时文件 ID 保存，取消返回 false，真实路径不进入渲染层', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const invoke: TauriInvoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push([command, args]);
      return { saved: false } as T;
    };
    const files = createTauriFileAdapter({ invoke });
    expect(files.saveDownload).toBeTypeOf('function');
    if (!files.saveDownload) return;
    const saved = await files.saveDownload({ id: 't1', handle: 'opaque-t1', name: 'internal.webp', mime: 'image/webp', size: 2, relativePath: 'internal.webp' }, 'hero.webp');
    expect(saved).toBe(false);
    expect(calls).toEqual([['save_temp_file', { tempFileId: 'opaque-t1', suggestedName: 'hero.webp' }]]);
  });
});
