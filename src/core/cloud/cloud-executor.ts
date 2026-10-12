import { LIMITS, PHASE1_DESTINATION_TYPES, TERMINAL_JOB_STATUSES, type BatchEvent, type BatchStatus, type Job } from '@tinypng/shared';
import type { FileAdapter, SourceFile } from '../files/contracts';
import { TaskQueue } from '../queues/task-queue';
import type { Executor } from '../workbench/executor';
import { isActive, type OutputState, type Pipeline, type WorkbenchError, type WorkbenchItem } from '../workbench/model';
import { ApiRequestError, type ApiClient } from './api-client';
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
  async start(): Promise<void> {
    const drafts = this.items.filter(item => item.status === 'draft');
    if (!drafts.length) return;
    try {
      await this.ensureBatch();
    } catch (error) {
      for (const item of drafts) this.fail(item, error);
      this.emit();
      return;
    }
    const batchId = this.batchId!;
    for (const item of drafts) { item.status = 'uploading'; item.progress = 0; }
    this.emit();

    const files = drafts.filter(item => item.source.kind === 'file');
    const urls = drafts.filter(item => item.source.kind === 'url');
    const uploads = files.map(item => this.uploadOne(batchId, item));
    if (urls.length) uploads.push(this.uploadUrls(batchId, urls));
    await Promise.all(uploads);

    if (!this.items.some(item => item.jobId && item.status === 'draft')) {
      this.emit();
      return;
    }
    this.openEvents();
    try {
      await this.options.api.start(batchId);
      for (const item of this.items) if (item.jobId && item.status === 'draft') item.status = 'queued';
    } catch (error) {
      for (const item of this.items) if (item.jobId && item.status === 'draft') this.fail(item, error);
    }
    this.emit();
  }

  cancel(itemId: string): void {
    const item = this.find(itemId);
    if (!item) return;
    if (item.status === 'draft' && !item.jobId) {
      item.status = 'canceled';
      this.emit();
      return;
    }
    this.uploadControllers.get(item.id)?.abort();
    if (item.jobId && !TERMINAL_JOB_STATUSES.includes(item.status)) {
      // 乐观显示，收到 canceled 事件定稿
      void this.options.api.cancelJob(item.jobId).catch(error => {
        item.error = toError(error);
        this.emit();
      });
    }
  }

  cancelAll(): void {
    for (const item of this.items) {
      if (item.status === 'draft' && !item.jobId) item.status = 'canceled';
      this.uploadControllers.get(item.id)?.abort();
    }
    if (this.batchId) void this.options.api.cancelBatch(this.batchId).catch(() => undefined);
    this.emit();
  }

  async retry(itemId: string, scope: 'all' | 'outputs'): Promise<void> {
    const item = this.find(itemId);
    if (!item) return;
    if (!item.jobId) {
      // 上传前就失败的：回到草稿，下次“开始处理”再上传
      item.status = 'draft';
      item.error = undefined;
      item.progress = 0;
      this.emit();
      return;
    }
    try {
      await this.options.api.retry(item.jobId, scope);
      item.error = undefined;
      if (scope === 'outputs') {
        item.status = 'saving';
        for (const o of item.outputs) if (o.status === 'failed') { o.status = 'saving'; o.error = undefined; }
      } else {
        item.status = 'queued';
        item.progress = 0;
      }
      this.openEvents();
    } catch (error) {
      item.error = toError(error);
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

  /** zip 全部下载（Server 打包） */
  async downloadArchive(): Promise<{ blob: Blob; filename: string }> {
    if (!this.batchId) throw new Error('还没有可下载的结果');
    return { blob: await this.options.api.archive(this.batchId), filename: 'images-' + this.batchId.slice(0, 8) + '.zip' };
  }

  /** 全量校正（重连后 / 手动刷新） */
  async refetch(): Promise<void> {
    if (!this.batchId) return;
    const batch = await this.options.api.getBatch(this.batchId);
    this.batchStatus = batch.status;
    for (const job of batch.jobs) {
      const item = this.items.find(i => i.jobId === job.jobId);
      if (item) applyJob(item, job, true);
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
    this.uploadControllers.set(item.id, controller);
    try {
      await this.uploadQueue.add(async ({ signal }) => {
        signal.addEventListener('abort', () => controller.abort(), { once: true });
        const bytes = await this.options.adapter.read(file);
        const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: file.mime });
        const res = await this.options.api.uploadFile(batchId, blob, file.name, ratio => {
          item.progress = ratio;
          this.emit();
        }, controller.signal);
        const job = res.jobs[0];
        if (!job) throw new Error('Server 没有返回任务');
        this.bind(item, job);
      }, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) item.status = 'canceled';
      else this.fail(item, error);
    } finally {
      this.uploadControllers.delete(item.id);
      this.emit();
    }
  }

  private async uploadUrls(batchId: string, items: CloudItem[]): Promise<void> {
    try {
      const res = await this.options.api.addUrls(batchId, items.map(i => (i.source.kind === 'url' ? i.source.url : '')));
      items.forEach((item, index) => {
        const job = res.jobs[index];
        if (job) this.bind(item, job);
        else this.fail(item, new Error('Server 没有返回任务'));
      });
    } catch (error) {
      for (const item of items) this.fail(item, error);
    }
  }

  private bind(item: CloudItem, job: Job): void {
    item.jobId = job.jobId;
    item.batchId = job.batchId;
    item.status = 'draft';
    item.progress = 1;
    if (job.input) item.originalSize = job.input.size;
    if (job.outputs.length) item.outputs = job.outputs.map(o => ({ ...o }));
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
        onReconnected: () => this.refetch().catch(() => undefined)
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
    if (item.status === 'canceled' && event.status !== 'canceled') return; // 取消后的迟到事件丢弃
    item.status = event.status;
    if (event.progress !== undefined) item.progress = event.progress;
    if (event.outputs) item.outputs = event.outputs.map(o => ({ ...o }));
    if (event.error) item.error = toError(event.error);
    else if (event.status !== 'failed') item.error = undefined;
    if (event.status === 'completed') item.progress = 1;
    // 进入 saving 说明 Provider 已出结果（output-failed 需要 hasResult）
    if ((event.status === 'saving' || event.status === 'completed') && !item.output) item.output = placeholderResult();
    this.emit();
    // 终态后补拉单个任务，拿结果尺寸/体积和尝试次数
    if (event.status === 'completed' || event.status === 'failed') void this.refreshJob(item);
  }

  private async refreshJob(item: CloudItem): Promise<void> {
    if (!item.jobId) return;
    try {
      applyJob(item, await this.options.api.getJob(item.jobId), false);
      this.emit();
    } catch {
      // 忽略，重连全量校正会兜底
    }
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
function applyJob(item: CloudItem, job: Job, full: boolean): void {
  if (item.status === 'canceled' && job.status !== 'canceled') return;
  item.status = job.status;
  item.attempts = job.attempts;
  if (job.progress !== undefined) item.progress = job.progress;
  if (job.input) item.originalSize = job.input.size;
  if (job.result) {
    item.compressedSize = job.result.size;
    // 云端没有本地字节，用占位表示“已有结果”，供 deriveDisplayStatus 的 hasResult
    item.output = { bytes: new Uint8Array(0), mime: job.result.mime, size: job.result.size, width: job.result.width, height: job.result.height, ratio: 1 - job.result.savedRatio };
  }
  item.outputs = job.outputs.map(o => ({ ...o }));
  item.error = job.error ? toError(job.error) : full ? undefined : item.error;
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
