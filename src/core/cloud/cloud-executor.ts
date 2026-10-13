import { LIMITS, PHASE1_DESTINATION_TYPES, TERMINAL_JOB_STATUSES, type BatchEvent, type BatchStatus, type Job } from '@tinypng/shared';
import type { FileAdapter, SourceFile } from '../files/contracts';
import { TaskQueue } from '../queues/task-queue';
import type { Executor } from '../workbench/executor';
import { isActive, type OutputState, type Pipeline, type WorkbenchError, type WorkbenchItem } from '../workbench/model';
import { ApiRequestError, throwIfAborted, type ApiClient } from './api-client';
import { SseClient, type ConnectionState, type SseClientOptions } from './sse';

export interface CloudExecutorOptions {
  api: ApiClient;
  adapter: FileAdapter;
  pipeline: Pipeline;
  /** 上传并发，默认 LIMITS.concurrency */
  uploadConcurrency?: number;
  sse?: Pick<SseClientOptions, 'idleTimeoutMs' | 'backoffMs'>;
}

interface CloudItem extends WorkbenchItem {
  /** 上传成功后 Server 分配 */
  jobId?: string;
}

/**
 * 云端执行器（Server API v0.2）：
 * - 加图只建本地草稿（不上传、不发请求）；点“开始处理”才建批次 → XHR 上传（带进度）→ POST /start
 * - fetch 读 SSE（Bearer），按 jobId 增量合并；终态不被迟到的非终态覆盖
 * - 30 秒无事件 → 连接中断 → 自动重连 → 先 GET /batches/:id 全量校正
 */
export class CloudExecutor implements Executor {
  readonly mode = 'cloud' as const;
  batchId?: string;
  batchStatus?: BatchStatus;
  connection: ConnectionState = 'idle';
  private readonly items: CloudItem[] = [];
  private readonly listeners = new Set<(items: readonly WorkbenchItem[]) => void>();
  private readonly connectionListeners = new Set<(state: ConnectionState) => void>();
  private readonly uploadQueue: TaskQueue;
  private readonly uploadControllers = new Map<string, AbortController>();
  private pipeline: Pipeline;
  private sse?: SseClient;
  private seq = 0;
  private idleWaiters: Array<() => void> = [];
  private startTail: Promise<void> = Promise.resolve();
  /** /start 响应丢失时先校正 Server 实态，不能误走 Provider retry。 */
  private readonly unconfirmedStarts = new Set<string>();
  private readonly unconfirmedRetries = new Set<string>();
  private readonly observedRetryEvents = new Set<string>();
  private readonly submittedJobs = new Set<string>();
  private readonly cancelledRemoteJobs = new Set<string>();
  private readonly pendingRemoteCancels = new Map<string, Promise<void>>();
  private needsUploadReconciliation = false;

  constructor(private readonly options: CloudExecutorOptions) {
    this.pipeline = options.pipeline;
    this.uploadQueue = new TaskQueue(options.uploadConcurrency ?? LIMITS.concurrency);
  }

  get snapshot(): readonly WorkbenchItem[] {
    return this.items;
  }

  addFiles(files: readonly SourceFile[]): void {
    for (const file of files) this.items.push(this.draft({ kind: 'file', file }, file.size));
    this.emit();
  }

  addUrls(urls: readonly string[]): void {
    for (const url of urls) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只支持 http/https 链接');
      this.items.push(this.draft({ kind: 'url', url }, 0));
    }
    this.emit();
  }

  setPipeline(pipeline: Pipeline): void {
    if (this.batchId) throw new Error('批次已创建，操作链不能再改；请清空后重建');
    this.pipeline = pipeline;
    for (const item of this.items) if (item.status === 'draft') item.outputs = this.outputs(item.id);
    this.emit();
  }

  /** “开始处理”：建批次（首次）→ 上传草稿 → /start → 订阅 SSE */
  start(): Promise<void> {
    const drafts = this.items.filter(item => item.status === 'draft');
    if (!drafts.length) return Promise.resolve();
    // 先认领这次草稿，再异步建批次，防止重复点击上传同一张图片。
    for (const item of drafts) { item.status = 'uploading'; item.progress = 0; item.error = undefined; }
    this.emit();
    const run = this.startTail.then(() => this.startDrafts(drafts));
    this.startTail = run.catch(() => undefined);
    return run;
  }

  private async startDrafts(drafts: CloudItem[]): Promise<void> {
    try {
      await this.ensureBatch();
    } catch (error) {
      for (const item of drafts) if (item.status !== 'canceled') this.fail(item, error);
      this.emit();
      return;
    }
    const batchId = this.batchId!;
    const files = drafts.filter(item => item.source.kind === 'file' && !item.jobId && item.status !== 'canceled');
    const urls = drafts.filter(item => item.source.kind === 'url' && !item.jobId && item.status !== 'canceled');
    const uploads = files.map(item => this.uploadOne(batchId, item));
    if (urls.length) uploads.push(this.uploadUrls(batchId, urls));
    await Promise.all(uploads);

    try {
      await this.confirmCancelledUploads();
    } catch {
      for (const item of drafts) if (item.jobId && item.status === 'uploading') {
        item.status = 'draft';
        item.error = { code: 'UNKNOWN', message: '取消确认失败，其余图片已保留为草稿。请恢复连接后再次开始。' };
      }
      this.emit();
      return;
    }

    const ready = drafts.filter(item => item.jobId && item.status === 'uploading');
    if (!ready.length) {
      this.emit();
      return;
    }
    this.openEvents();
    for (const item of ready) if (item.jobId) this.submittedJobs.add(item.jobId);
    try {
      await this.options.api.start(batchId);
      for (const item of ready) if (item.status === 'uploading') item.status = 'queued';
    } catch (error) {
      for (const item of ready) this.unconfirmedStarts.add(item.id);
      try {
        await this.refetch();
        for (const item of ready) if (item.status === 'draft') item.error = { code: 'UNKNOWN', message: 'Server 尚未开始处理，已恢复草稿。请再次点击开始处理。' };
      } catch {
        for (const item of ready) if (item.status !== 'canceled') this.fail(item, new Error('暂时无法确认 Server 是否开始处理，请恢复连接后重试'));
      }
    }
    this.emit();
  }

  async cancel(itemId: string): Promise<void> {
    const item = this.find(itemId);
    if (!item) return;
    if (!item.jobId && !TERMINAL_JOB_STATUSES.includes(item.status)) {
      item.status = 'canceled';
      this.uploadControllers.get(item.id)?.abort();
      this.emit();
      return;
    }
    this.uploadControllers.get(item.id)?.abort();
    if (item.jobId && item.status === 'uploading' && !this.submittedJobs.has(item.jobId)) {
      item.status = 'canceled';
      this.emit();
      await this.compensateCancel(item.jobId);
      return;
    }
    if (item.jobId && !TERMINAL_JOB_STATUSES.includes(item.status)) {
      // 乐观显示，收到 canceled 事件定稿
      try {
        await this.options.api.cancelJob(item.jobId);
        // 完成与取消可能竞争，终态时 Server 无须再次推送 canceled 事件。
        applyJob(item, await this.options.api.getJob(item.jobId), true);
        this.emit();
      } catch (error) {
        item.error = toError(error);
        this.emit();
        throw error;
      }
    }
  }

  async cancelAll(): Promise<void> {
    for (const item of this.items) {
      if (!item.jobId && !TERMINAL_JOB_STATUSES.includes(item.status)) item.status = 'canceled';
      this.uploadControllers.get(item.id)?.abort();
    }
    this.emit();
    if (this.batchId) {
      await this.options.api.cancelBatch(this.batchId);
      await this.refetch();
    }
  }

  async retry(itemId: string, scope: 'all' | 'outputs'): Promise<void> {
    const item = this.find(itemId);
    if (!item) return;
    if (item.jobId && this.unconfirmedRetries.has(item.id)) {
      applyJob(item, await this.options.api.getJob(item.jobId), true, 'retry');
      this.unconfirmedRetries.delete(item.id);
      this.observedRetryEvents.delete(item.id);
      if (isActive(item.status)) this.openEvents();
      this.emit();
      return;
    }
    if (this.unconfirmedStarts.has(item.id)) {
      await this.refetch();
      if (this.unconfirmedStarts.has(item.id)) throw new Error('Server 中没有找到已上传任务，请清空后重新添加');
      if (item.status === 'draft' || item.status === 'completed' || isActive(item.status)) {
        if (isActive(item.status)) this.openEvents();
        return;
      }
    }
    if (!item.jobId) {
      // 上传前就失败的：回到草稿，下次“开始处理”再上传
      item.status = 'draft';
      item.error = undefined;
      item.progress = 0;
      this.emit();
      return;
    }
    const previous = { ...item, outputs: item.outputs.map(output => ({ ...output })) };
    // 先进入重试状态，SSE 可能比 HTTP 响应更早报告完成，不能随后回退。
    item.error = undefined;
    if (scope === 'outputs') {
      item.status = 'saving';
      for (const output of item.outputs) if (output.status === 'failed') { output.status = 'saving'; output.error = undefined; }
    } else {
      item.status = 'queued';
      item.progress = 0;
      item.output = undefined;
      item.compressedSize = undefined;
    }
    this.emit();
    this.unconfirmedRetries.add(item.id);
    this.observedRetryEvents.delete(item.id);
    try {
      await this.options.api.retry(item.jobId, scope);
      this.unconfirmedRetries.delete(item.id);
      this.observedRetryEvents.delete(item.id);
      this.openEvents();
    } catch (error) {
      try {
        applyJob(item, await this.options.api.getJob(item.jobId), true, 'retry');
        this.unconfirmedRetries.delete(item.id);
        this.observedRetryEvents.delete(item.id);
        if (isActive(item.status)) this.openEvents();
      } catch {
        if (!this.observedRetryEvents.has(item.id) && !TERMINAL_JOB_STATUSES.includes(item.status)) Object.assign(item, previous);
        item.error = { code: 'UNKNOWN', message: '无法确认重试是否已被 Server 接受，请恢复连接后重试。', cause: error };
        this.emit();
        throw new Error(item.error.message);
      }
    }
    this.emit();
  }

  remove(itemId: string): boolean {
    const index = this.items.findIndex(item => item.id === itemId);
    const item = this.items[index];
    if (!item || isActive(item.status)) return false;
    this.items.splice(index, 1);
    if (item.jobId && item.status === 'draft' && this.batchId) void this.options.api.deleteItem(this.batchId, item.jobId).catch(() => undefined);
    this.emit();
    return true;
  }

  subscribe(listener: (items: readonly WorkbenchItem[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.items);
    return () => this.listeners.delete(listener);
  }

  onConnection(listener: (state: ConnectionState) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  /** 所有已开始的任务进入终态 */
  idle(): Promise<void> {
    if (!this.hasActive()) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  /** 单张下载 */
  async download(itemId: string): Promise<{ blob: Blob; filename: string }> {
    const item = this.find(itemId);
    if (!item?.jobId) throw new Error('结果还没生成');
    const blob = await this.options.api.result(item.jobId);
    return { blob, filename: resultName(item, blob.type) };
  }

  async resultBlob(itemId: string): Promise<Blob | undefined> {
    const item = this.find(itemId);
    if (!item?.jobId || !item.output) return undefined;
    return this.options.api.result(item.jobId);
  }

  async sourceBlob(itemId: string): Promise<Blob | undefined> {
    const item = this.find(itemId);
    if (item?.source.kind !== 'file') return undefined;
    const bytes = await this.options.adapter.read(item.source.file);
    return new Blob([bytes.slice().buffer as ArrayBuffer], { type: item.source.file.mime });
  }

  /** zip 全部下载（Server 打包） */
  async downloadArchive(signal?: AbortSignal): Promise<{ blob: Blob; filename: string }> {
    if (!this.batchId) throw new Error('还没有可下载的结果');
    return { blob: await this.options.api.archive(this.batchId, signal), filename: 'images-' + this.batchId.slice(0, 8) + '.zip' };
  }

  /** 全量校正（重连后 / 手动刷新） */
  async refetch(signal?: AbortSignal): Promise<void> {
    if (!this.batchId) return;
    const batch = await this.options.api.getBatch(this.batchId, signal);
    // 请求实现可能忽略取消；迟到校正不能在关闭后改写任务。
    throwIfAborted(signal);
    this.batchStatus = batch.status;
    for (const job of batch.jobs) {
      const item = this.items.find(i => i.jobId === job.jobId);
      if (item) {
        applyJob(item, job, true, this.unconfirmedRetries.has(item.id) ? 'retry' : this.unconfirmedStarts.has(item.id) ? 'start' : undefined);
        if (job.status === 'draft') this.submittedJobs.delete(job.jobId);
        this.unconfirmedStarts.delete(item.id);
        this.unconfirmedRetries.delete(item.id);
        this.observedRetryEvents.delete(item.id);
      }
    }
    this.emit();
  }

  async dispose(): Promise<void> {
    for (const c of this.uploadControllers.values()) c.abort();
    this.listeners.clear();
    await this.sse?.stop();
  }

  // ---- 内部 ----

  private draft(source: CloudItem['source'], size: number): CloudItem {
    const id = 'c' + String(++this.seq);
    return { id, batchId: '', mode: 'cloud', source, status: 'draft', progress: 0, attempts: 0, originalSize: size, outputs: this.outputs(id) };
  }

  private outputs(id: string): OutputState[] {
    return this.pipeline.destinations.map((destination, i) => ({ outputId: id + '-o' + String(i), destination, status: 'pending' }));
  }

  private find(id: string): CloudItem | undefined {
    return this.items.find(item => item.id === id);
  }

  private async ensureBatch(): Promise<void> {
    if (this.batchId) return;
    const bad = this.pipeline.destinations.find(d => !PHASE1_DESTINATION_TYPES.includes(d.type));
    if (bad) throw new ApiRequestError(422, { code: 'VALIDATION_FAILED', message: '第一阶段只支持下载输出', retryable: false, requestId: '' });
    const res = await this.options.api.createBatch({
      providerId: this.pipeline.providerId,
      operations: this.pipeline.operations,
      destinations: this.pipeline.destinations
    });
    this.batchId = res.batchId;
    this.batchStatus = res.status;
  }

  private async uploadOne(batchId: string, item: CloudItem): Promise<void> {
    if (item.source.kind !== 'file') return;
    const file = item.source.file;
    const controller = new AbortController();
    let uploadAttempted = false;
    this.uploadControllers.set(item.id, controller);
    try {
      await this.uploadQueue.add(async ({ signal }) => {
        throwIfAborted(signal);
        throwIfAborted(controller.signal);
        signal.addEventListener('abort', () => controller.abort(), { once: true });
        const bytes = await this.options.adapter.read(file);
        throwIfAborted(signal);
        throwIfAborted(controller.signal);
        const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: file.mime });
        uploadAttempted = true;
        const res = await this.options.api.uploadFile(batchId, blob, file.name, ratio => {
          item.progress = ratio;
          this.emit();
        }, controller.signal);
        const job = res.jobs[0];
        if (!job) throw new Error('Server 没有返回任务');
        await this.bind(item, job, controller.signal);
      }, { signal: controller.signal });
    } catch (error) {
      if (uploadAttempted && !item.jobId) this.needsUploadReconciliation = true;
      if (controller.signal.aborted) item.status = 'canceled';
      else this.fail(item, error);
    } finally {
      this.uploadControllers.delete(item.id);
      this.emit();
    }
  }

  private async uploadUrls(batchId: string, items: CloudItem[]): Promise<void> {
    // 每个 URL 独立取消；取消一张不会中断同批次其他 URL。
    await Promise.all(items.map(item => this.uploadUrl(batchId, item)));
  }

  private async uploadUrl(batchId: string, item: CloudItem): Promise<void> {
    const controller = new AbortController();
    let uploadAttempted = false;
    this.uploadControllers.set(item.id, controller);
    try {
      const res = await this.uploadQueue.add(() => {
        throwIfAborted(controller.signal);
        uploadAttempted = true;
        return this.options.api.addUrls(batchId, [item.source.kind === 'url' ? item.source.url : ''], controller.signal);
      }, { signal: controller.signal });
      const job = res.jobs[0];
      if (job) await this.bind(item, job, controller.signal);
      else if (item.status !== 'canceled') this.fail(item, new Error('Server 没有返回任务'));
    } catch (error) {
      if (uploadAttempted && !item.jobId) this.needsUploadReconciliation = true;
      if (item.status !== 'canceled') {
        if (controller.signal.aborted) item.status = 'canceled';
        else this.fail(item, error);
      }
    } finally {
      this.uploadControllers.delete(item.id);
      this.emit();
    }
  }

  private async bind(item: CloudItem, job: Job, signal?: AbortSignal): Promise<void> {
    item.jobId = job.jobId;
    item.batchId = job.batchId;
    if (item.status === 'canceled' || signal?.aborted) {
      item.status = 'canceled';
      await this.compensateCancel(job.jobId);
      return;
    }
    item.status = 'uploading';
    item.progress = 1;
    if (job.input) item.originalSize = job.input.size;
    if (job.outputs.length) item.outputs = job.outputs.map(o => ({ ...o }));
  }

  /** 已上传但被取消的草稿必须确认撤销，不能让随后/start把它们一起计费。 */
  private async compensateCancel(jobId: string): Promise<void> {
    this.cancelledRemoteJobs.add(jobId);
    let request = this.pendingRemoteCancels.get(jobId);
    if (!request) {
      request = this.options.api.cancelJob(jobId);
      this.pendingRemoteCancels.set(jobId, request);
    }
    try {
      await request;
      this.cancelledRemoteJobs.delete(jobId);
    } finally {
      if (this.pendingRemoteCancels.get(jobId) === request) this.pendingRemoteCancels.delete(jobId);
    }
  }

  private async confirmCancelledUploads(): Promise<void> {
    if (this.needsUploadReconciliation && this.batchId) {
      const batch = await this.options.api.getBatch(this.batchId);
      const known = new Set(this.items.flatMap(item => item.jobId ? [item.jobId] : []));
      for (const job of batch.jobs) if (job.status === 'draft' && !known.has(job.jobId)) this.cancelledRemoteJobs.add(job.jobId);
    }
    await Promise.all([...this.cancelledRemoteJobs].map(jobId => this.compensateCancel(jobId)));
    this.needsUploadReconciliation = false;
  }

  private fail(item: CloudItem, error: unknown): void {
    item.status = 'failed';
    item.error = toError(error);
  }

  private openEvents(): void {
    if (!this.batchId) return;
    if (!this.sse) {
      const batchId = this.batchId;
      this.sse = new SseClient({
        ...this.options.sse,
        open: signal => this.options.api.events(batchId, signal),
        onEvent: event => this.onEvent(event),
        onState: state => {
          this.connection = state;
          this.connectionListeners.forEach(l => l(state));
        },
        onReconnected: signal => this.refetch(signal)
      });
    }
    this.sse.start();
  }

  private onEvent(event: BatchEvent): void {
    if (event.type === 'heartbeat') return;
    if (event.type === 'batch') {
      this.batchStatus = event.status;
      this.emit();
      // 批次到终态且本地无进行中任务时关流；再次 start/retry 会重新打开
      if (event.status !== 'running' && event.status !== 'draft' && !this.hasActive()) void this.sse?.stop();
      return;
    }
    const item = this.items.find(i => i.jobId === event.jobId);
    if (!item) return;
    const retryRecovery = this.unconfirmedRetries.has(item.id) && (isActive(event.status) || event.status === 'completed' || event.status === 'failed');
    if (!retryRecovery && item.status === 'canceled' && event.status !== 'canceled') return;
    if (!retryRecovery && TERMINAL_JOB_STATUSES.includes(item.status) && !TERMINAL_JOB_STATUSES.includes(event.status)) return;
    if (retryRecovery) this.observedRetryEvents.add(item.id);
    if (event.status === 'processing' && item.status !== 'processing') item.attempts += 1;
    item.status = event.status;
    if (event.progress !== undefined) item.progress = event.progress;
    if (event.outputs) item.outputs = event.outputs.map(o => ({ ...o }));
    if (event.error) item.error = toError(event.error);
    else if (event.status !== 'failed') item.error = undefined;
    if (event.status === 'completed') item.progress = 1;
    // completed（或已有结果）事件带 result（API v0.2 / 6b88d01）
    if (event.result) applyResult(item, event.result);
    // 进入 saving 说明 Provider 已出结果（output-failed 需要 hasResult）
    else if ((event.status === 'saving' || event.status === 'completed') && !item.output) item.output = placeholderResult();
    this.emit();
  }

  private hasActive(): boolean {
    return this.items.some(item => isActive(item.status));
  }

  private emit(): void {
    for (const l of this.listeners) l(this.items);
    if (!this.hasActive()) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach(w => w());
    }
  }
}

/** 全量合并：Server 为准，但不让非终态覆盖本地已收到的 canceled */
function applyJob(item: CloudItem, job: Job, full: boolean, reconcileRequest?: 'start' | 'retry'): void {
  if (reconcileRequest !== 'retry' && item.status === 'canceled' && job.status !== 'canceled') return;
  if (!reconcileRequest && TERMINAL_JOB_STATUSES.includes(item.status) && !TERMINAL_JOB_STATUSES.includes(job.status)) return;
  item.status = job.status;
  item.attempts = job.attempts;
  if (job.progress !== undefined) item.progress = job.progress;
  if (job.input) item.originalSize = job.input.size;
  if (job.result) applyResult(item, job.result);
  item.outputs = job.outputs.map(o => ({ ...o }));
  item.error = job.error ? toError(job.error) : full ? undefined : item.error;
}

/** 云端没有本地字节，用元信息表示“已有结果”，供 deriveDisplayStatus 的 hasResult 和画布标签 */
function applyResult(item: CloudItem, result: NonNullable<Job['result']>): void {
  item.compressedSize = result.size;
  item.output = { bytes: new Uint8Array(0), mime: result.mime, size: result.size, width: result.width, height: result.height, ratio: 1 - result.savedRatio };
}

function placeholderResult(): NonNullable<WorkbenchItem['output']> {
  return { bytes: new Uint8Array(0), mime: '', size: 0, width: 0, height: 0, ratio: 0 };
}

function toError(error: unknown): WorkbenchError {
  if (error instanceof ApiRequestError) return { code: error.error.code, message: error.error.message, cause: error.error };
  if (typeof error === 'object' && error && 'code' in error && 'message' in error) {
    const e = error as { code: WorkbenchError['code']; message: string };
    return { code: e.code, message: e.message, cause: error };
  }
  return { code: 'UNKNOWN', message: error instanceof Error ? error.message : '请求失败', cause: error };
}

function resultName(item: CloudItem, mime: string): string {
  const base = item.source.kind === 'file' ? item.source.file.name : new URL(item.source.url).pathname.split('/').pop() || 'image';
  const ext = mime.split('/')[1]?.replace('jpeg', 'jpg');
  return ext ? base.replace(/\.[^.]+$/, '') + '.' + ext : base;
}
