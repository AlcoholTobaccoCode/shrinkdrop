import { computed, reactive } from 'vue';
import { TaskQueue } from '../queues/task-queue';
import { createUUID } from './id';
import type { CompressionResult, LiteAdapter, ProgressEvent, SourceFile } from './types';

//#region 任务状态
export type ItemStatus = 'draft' | 'queued' | 'processing' | 'completed' | 'canceled' | 'failed';
export interface LiteItem {
  id: string;
  source: SourceFile;
  status: ItemStatus;
  attempt: number;
  taskId?: string;
  stage?: ProgressEvent['stage'];
  thumbnailUrl?: string;
  thumbnailFailed?: boolean;
  result?: CompressionResult;
  error?: string;
  cancelPending: boolean;
  cancelError?: string;
  saving: boolean;
  saved: boolean;
  saveError?: string;
}
interface Attempt {
  taskId: string;
  controller: AbortController;
  canceled: boolean;
  cancelPromise?: Promise<boolean>;
}
interface SessionOptions {
  sessionId?: string;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}
const supported = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp']
]);
export const MAX_FILE_BYTES = 20_000_000;
const IMPORT_EMPTY_ERROR = '没有可导入的图片，请确认文件可读、格式为 PNG/JPG/WebP，单张不超过 20 MB';
//#endregion

export function createLiteSession(adapter: LiteAdapter, options: SessionOptions = {}) {
  //#region 会话与统计
  let sessionId = options.sessionId ?? createUUID();
  const createURL = options.createObjectURL ?? (blob => URL.createObjectURL(blob));
  const revokeURL = options.revokeObjectURL ?? (url => URL.revokeObjectURL(url));
  const queue = new TaskQueue(5);
  const thumbnails = new TaskQueue(3);
  const attempts = new Map<string, Attempt>();
  const pendingSaves = new Set<Promise<void>>();
  let nextId = 0;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  const state = reactive({
    items: [] as LiteItem[], notice: '', noticeKind: 'info' as 'info' | 'success' | 'error',
    importing: false, clearing: false, bulkSaving: false
  });
  const summary = computed(() => {
    const completed = state.items.filter(item => item.status === 'completed' && item.result);
    return {
      count: state.items.length,
      draft: state.items.filter(item => item.status === 'draft').length,
      active: state.items.filter(item => item.status === 'queued' || item.status === 'processing').length,
      completed: completed.length,
      failed: state.items.filter(item => item.status === 'failed').length,
      canceled: state.items.filter(item => item.status === 'canceled').length,
      originalBytes: state.items.reduce((total, item) => total + item.source.size, 0),
      savedBytes: completed.reduce((total, item) => total + item.source.size - item.result!.size, 0),
      saving: state.bulkSaving || state.items.some(item => item.saving)
    };
  });
  function notify(message: string, kind: typeof state.noticeKind = 'info') {
    state.notice = message; state.noticeKind = kind;
  }
  function find(id: string) { return state.items.find(item => item.id === id); }
  function present(item: LiteItem) { return !disposed && Boolean(find(item.id)); }
  function current(item: LiteItem, attempt: Attempt) {
    return present(item) && attempts.get(item.id) === attempt && !attempt.canceled;
  }
  function revokeThumbnail(item: LiteItem) {
    if (item.thumbnailUrl) revokeURL(item.thumbnailUrl);
    item.thumbnailUrl = undefined;
  }
  //#endregion

  //#region 导入与预览
  async function importSources(sources: SourceFile[], importOptions: { reportEmpty?: boolean } = {}) {
    if (disposed || state.clearing) return;
    if (!sources.length && importOptions.reportEmpty) {
      notify(IMPORT_EMPTY_ERROR, 'error'); return;
    }
    state.importing = true;
    let skipped = 0;
    const reads: Promise<void>[] = [];
    for (const source of sources) {
      const extension = source.name.split('.').pop()?.toLowerCase() ?? '';
      const expectedMime = supported.get(extension);
      if (!expectedMime || (source.mime && source.mime.toLowerCase() !== expectedMime)
        || !Number.isFinite(source.size) || source.size <= 0 || source.size > MAX_FILE_BYTES
        || state.items.some(item => item.source.id === source.id)) {
        skipped += 1; continue;
      }
      state.items.push({
        id: String(++nextId), source, status: 'draft', attempt: 0,
        cancelPending: false, saving: false, saved: false
      });
      const item = state.items[state.items.length - 1]!;
      reads.push(thumbnails.add(async () => {
        try {
          const bytes = await adapter.readFile(source);
          const thumbnailUrl = createURL(new Blob([new Uint8Array(bytes)], { type: expectedMime }));
          if (present(item)) item.thumbnailUrl = thumbnailUrl;
          else revokeURL(thumbnailUrl);
        } catch {
          // 缩略图读取失败不影响压缩，列表仍保留文件名和大小。
        }
      }));
    }
    if (skipped) notify(`已跳过 ${skipped} 个重复或无效文件。支持 PNG、JPEG、WebP，单张不超过 20 MB。`);
    else if (sources.length) state.notice = '';
    await Promise.all(reads);
    state.importing = false;
  }
  async function choose(kind: 'files' | 'directory') {
    if (state.importing || state.clearing || disposed) return;
    state.importing = true;
    try {
      await importSources(await (kind === 'files' ? adapter.chooseFiles() : adapter.chooseDirectory()));
    } catch (error) {
      notify(errorMessage(error) === IMPORT_EMPTY_ERROR ? IMPORT_EMPTY_ERROR : '无法读取所选文件，请重新选择。', 'error');
    } finally { state.importing = false; }
  }
  //#endregion

  //#region 压缩与取消
  function enqueue(item: LiteItem) {
    item.attempt += 1;
    const attempt: Attempt = {
      taskId: `${sessionId}-${item.id}-${item.attempt}`, controller: new AbortController(), canceled: false
    };
    attempts.set(item.id, attempt);
    Object.assign(item, {
      status: 'queued', taskId: attempt.taskId, stage: undefined, result: undefined,
      error: undefined, cancelError: undefined, cancelPending: false, saved: false, saveError: undefined
    });
    void queue.add(async () => {
      if (!current(item, attempt)) return;
      item.status = 'processing'; item.stage = 'uploading';
      try {
        const result = await adapter.compress(item.source.id, attempt.taskId);
        if (attempt.cancelPromise) await attempt.cancelPromise;
        if (!current(item, attempt)) return;
        if (!result.tempFileId || !Number.isFinite(result.size) || result.size <= 0) {
          throw new Error('invalid result');
        }
        item.result = result; item.status = 'completed'; item.stage = undefined;
        item.cancelError = undefined;
      } catch (error) {
        if (attempt.cancelPromise) await attempt.cancelPromise;
        if (!current(item, attempt)) return;
        item.status = 'failed'; item.stage = undefined;
        item.cancelError = undefined;
        item.error = compressionError(error);
      }
    }, { signal: attempt.controller.signal }).catch(() => {
      // 排队期间取消会拒绝队列 Promise，此时状态已由 cancel 更新。
    });
  }
  function start() {
    if (!adapter.desktop || disposed || state.clearing) return;
    state.notice = '';
    state.items.filter(item => item.status === 'draft').forEach(enqueue);
  }
  function retry(id: string) {
    const item = find(id);
    if (!adapter.desktop || disposed || state.clearing || !item
      || (item.status !== 'failed' && item.status !== 'canceled')) return;
    enqueue(item);
  }
  async function cancel(id: string): Promise<boolean> {
    const item = find(id);
    if (!item) return true;
    if (item.status === 'draft') { item.status = 'canceled'; return true; }
    const attempt = attempts.get(id);
    if (!attempt || (item.status !== 'queued' && item.status !== 'processing')) return true;
    if (item.status === 'queued') {
      attempt.canceled = true; attempt.controller.abort(); item.status = 'canceled';
      item.stage = undefined; return true;
    }
    if (item.cancelPending && attempt.cancelPromise) return attempt.cancelPromise;
    item.cancelPending = true; item.cancelError = undefined;
    attempt.cancelPromise = (async () => {
      try {
        await adapter.cancel(attempt.taskId);
        attempt.canceled = true; attempt.controller.abort();
        if (attempts.get(id) === attempt) {
          item.status = 'canceled'; item.stage = undefined;
        }
        return true;
      } catch {
        item.cancelError = '取消未成功，任务仍在进行，请再试一次。';
        return false;
      } finally { item.cancelPending = false; }
    })();
    return attempt.cancelPromise;
  }
  function updateProgress(event: ProgressEvent) {
    if (disposed) return;
    const item = state.items.find(item => item.taskId === event.taskId);
    if (item?.status === 'processing' && !item.cancelPending) item.stage = event.stage;
  }
  //#endregion

  //#region 保存结果
  function trackSave<T>(promise: Promise<T>): Promise<T> {
    const settled = promise.then(() => undefined, () => undefined);
    pendingSaves.add(settled);
    void settled.then(() => pendingSaves.delete(settled));
    return promise;
  }
  async function save(id: string) {
    const item = find(id);
    if (!adapter.desktop || disposed || state.clearing || state.bulkSaving
      || !item?.result || item.status !== 'completed' || item.saving) return;
    item.saving = true; item.saveError = undefined;
    try {
      const result = await trackSave(adapter.save(item.result.tempFileId, item.source.name));
      if (result.saved) { item.saved = true; notify(`已保存 ${item.source.name}。`, 'success'); }
      else notify('已取消保存。');
    } catch (error) { item.saveError = saveError(error); }
    finally { item.saving = false; }
  }
  async function saveAll() {
    if (!adapter.desktop || disposed || state.clearing || summary.value.saving) return;
    const items = state.items.filter(item => item.status === 'completed' && item.result);
    if (!items.length) return;
    state.bulkSaving = true;
    items.forEach(item => { item.saveError = undefined; });
    try {
      const result = await trackSave(adapter.saveResults(items.map(item => item.result!.tempFileId)));
      const failed = new Map(result.failed.map(failure => [failure.id, saveError(failure.message)]));
      for (const item of items) {
        if (failed.has(item.result!.tempFileId)) item.saveError = failed.get(item.result!.tempFileId);
        else if (!result.canceled && result.saved === items.length - failed.size) item.saved = true;
      }
      if (result.canceled) notify('已取消保存。');
      else if (result.failed.length) notify(`已保存 ${result.saved} 张，${result.failed.length} 张保存失败，可单独重试。`, 'error');
      else notify(`已保存 ${result.saved} 张图片。`, 'success');
    } catch (error) {
      const message = saveError(error);
      items.forEach(item => { item.saveError = message; });
      notify(message, 'error');
    } finally { state.bulkSaving = false; }
  }
  //#endregion

  //#region 移除与资源清理
  function remove(id: string): boolean {
    const item = find(id);
    if (!item || state.clearing || summary.value.saving
      || item.status === 'queued' || item.status === 'processing') return false;
    revokeThumbnail(item);
    state.items = state.items.filter(entry => entry.id !== id);
    return true;
  }
  async function cleanup(retiredSessionId: string) {
    try { await adapter.cleanup(retiredSessionId); }
    catch { if (!disposed) notify('列表已清空，但临时文件清理未完成。请关闭应用后重试。', 'error'); }
  }
  async function clear(): Promise<boolean> {
    if (disposed || state.clearing || summary.value.saving) return false;
    state.clearing = true;
    const retiredSessionId = sessionId;
    try {
      const canceled = await Promise.all(state.items.map(item => cancel(item.id)));
      if (canceled.some(success => !success)) {
        notify('部分任务未能取消，列表已保留，请稍后再试。', 'error'); return false;
      }
      // 原生请求真正结束后再清理，避免晚到结果写入已清空的会话。
      await queue.onIdle();
      state.items.forEach(revokeThumbnail); state.items = []; state.notice = '';
      await thumbnails.onIdle(); await cleanup(retiredSessionId);
      // 原生清理会永久关闭旧会话，后续导入必须使用新的会话标识。
      attempts.clear();
      if (!disposed) sessionId = createUUID();
      return true;
    } finally { state.clearing = false; }
  }
  function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;
    disposed = true;
    const retiredSessionId = sessionId;
    state.items.forEach(revokeThumbnail);
    disposePromise = (async () => {
      await Promise.all(state.items.map(item => cancel(item.id)));
      await queue.onIdle(); await thumbnails.onIdle();
      await Promise.all([...pendingSaves]); await cleanup(retiredSessionId);
    })();
    return disposePromise;
  }
  //#endregion

  return { state, summary, get sessionId() { return sessionId; }, importSources, choose, start, retry, cancel, updateProgress,
    save, saveAll, remove, clear, dispose, whenIdle: () => queue.onIdle(), notify };
}

//#region 面向用户的错误反馈
const nativeCompressionMessages = new Map([
  '匿名压缩被服务拒绝，请稍后再试',
  '压缩请求太频繁，请稍后再试',
  '服务拒绝了这张图片，请选择较小的图片',
  '压缩服务暂时不可用，请稍后重试',
  '压缩服务返回了不受支持的跳转，请稍后重试',
  '无法连接压缩服务，请检查网络后重试',
  '无法初始化网络连接，请重新启动应用',
  '压缩服务响应超时，请重试',
  '压缩超过 60 秒，请检查网络后重试',
  '图片已损坏，无法读取',
  '图片内容不完整或已损坏，请换一张图片',
  '图片尺寸过大，请先缩小图片',
  '图片为空或超过 20MB，请选择较小的图片',
  '文件不是有效的 PNG、JPG 或 WebP 图片',
  '仅支持 PNG、JPG 和 WebP 图片',
  '图片读取失败，请重试',
  '无法准备压缩请求，请重试',
  '压缩服务返回了无法识别的结果，请稍后重试',
  '服务返回的数据过大，请稍后重试',
  '服务返回了无效的下载地址',
  '服务返回了不受支持的下载地址，请稍后重试',
  '压缩结果的格式或尺寸异常，请稍后重试',
  '压缩结果的格式或尺寸异常，请重试',
  '压缩结果下载失败，请重试',
  '压缩结果下载不完整，请重试',
  '下载中断，请重试',
  '压缩结果校验失败，请重试',
  '压缩结果暂存失败，请重试'
].map(message => [message, message]));

function compressionError(error: unknown): string {
  const message = errorMessage(error);
  const fallback = '压缩失败，请稍后重试。';
  // 只展示原生端约定的固定文案，服务正文和未知错误都不能直接进入界面。
  if (/[<>]/.test(message)) return fallback;
  const nativeMessage = nativeCompressionMessages.get(message);
  if (nativeMessage) return nativeMessage;
  if (/\b(?:401|403)\b/.test(message)) return '匿名压缩被服务拒绝，请稍后再试';
  if (/\b429\b|too many/i.test(message)) return '压缩请求太频繁，请稍后再试';
  if (/\b413\b/.test(message)) return '服务拒绝了这张图片，请选择较小的图片';
  if (/network|connect|timeout|dns/i.test(message)) return '网络连接失败，请检查网络后重试。';
  return fallback;
}
const nativeSaveMessages = new Map([
  '请换一个文件名或目录，保存结果不能覆盖原图',
  '目标文件已存在，请换一个文件名',
  '无法访问保存目录，请换一个位置',
  '压缩结果已失效，请重新处理',
  '压缩结果无法读取，请重新处理',
  '保存失败，目标文件已存在或目录不可写',
  '同名文件过多，请换一个保存目录',
  '保存位置不能是压缩结果的临时文件',
  '无法创建保存文件，请换一个目录',
  '保存失败，请检查可用空间后重试',
  '保存位置无效',
  '保存目录无效',
  '保存文件名无效',
  '保存失败，请重试',
  '批量保存失败，请重试'
].map(message => [message, message]));

function saveError(error: unknown): string {
  return nativeSaveMessages.get(errorMessage(error)) ?? '保存失败，请检查目标文件夹或可用空间后重试。';
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : '';
}
//#endregion
