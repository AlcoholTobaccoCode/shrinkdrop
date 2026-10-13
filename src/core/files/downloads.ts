import { zip, type Zippable } from 'fflate';
import type { FileAdapter } from './contracts';
import type { WorkbenchItem } from '../workbench/model';

//#region 下载文件名与保存
export function resultFilename(item: WorkbenchItem, mime: string): string {
  const source = item.source.kind === 'file' ? item.source.file.name : new URL(item.source.url).pathname.split('/').pop() || 'image';
  const name = source.split(/[\\/]/).pop()?.replace(/[\x00-\x1f<>:"|?*]/g, '_') || 'image';
  const extension = mime.split('/')[1]?.split(';')[0]?.replace('jpeg', 'jpg') || 'bin';
  return (name.replace(/\.[^.]+$/, '').replace(/^\.+/, '') || 'image') + '.' + extension;
}

/** 两端统一下载入口；Tauri 仅以临时文件 ID 调系统保存窗口。 */
export async function saveBlob(adapter: FileAdapter, blob: Blob, filename: string): Promise<boolean> {
  if (!adapter.saveDownload) throw new Error('当前平台暂不支持保存文件');
  const taskId = 'download-' + crypto.randomUUID();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const temp = await adapter.writeTemp(taskId, bytes, filename.split('.').pop() || 'bin', blob.type);
  try {
    return await adapter.saveDownload(temp, filename);
  } finally {
    // Web 下载由浏览器异步接管，短暂保留 blob URL；桌面文件同样按会话清理。
    setTimeout(() => { void adapter.cleanup(taskId).catch(() => undefined); }, 30_000);
  }
}
//#endregion

//#region 本地 zip 归档
export function hasDownloadResult(item: WorkbenchItem): boolean {
  return Boolean(item.output) && item.outputs.some(output => output.status === 'completed');
}

/** 重名加序号，只打包成功输出；取消归档不影响任务或 Provider。 */
export function archiveResults(items: readonly WorkbenchItem[], signal?: AbortSignal): Promise<Blob> {
  if (signal?.aborted) return Promise.reject(new DOMException('已取消打包', 'AbortError'));
  const entries: Zippable = Object.create(null) as Zippable;
  const names = new Set<string>();
  for (const item of items.filter(hasDownloadResult)) {
    const base = resultFilename(item, item.output!.mime);
    let name = base;
    let index = 2;
    while (names.has(name)) name = base.replace(/(\.[^.]+)$/, ' (' + String(index++) + ')$1');
    names.add(name);
    entries[name] = item.output!.bytes;
  }
  if (!names.size) return Promise.reject(new Error('还没有成功的结果可供打包'));
  return new Promise((resolve, reject) => {
    const abort = () => {
      terminate();
      reject(new DOMException('已取消打包', 'AbortError'));
    };
    const terminate = zip(entries, { level: 0 }, (error, bytes) => {
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (signal?.aborted) reject(new DOMException('已取消打包', 'AbortError'));
      else resolve(new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/zip' }));
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
//#endregion
