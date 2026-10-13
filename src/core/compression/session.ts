import { LIMITS, PHASE1_DESTINATION_TYPES } from '@tinypng/shared';
import type { OutputDestination, ProcessingPolicy } from '@tinypng/shared';
import type { FileAdapter, SourceFile, TempFile } from '../files/contracts';
import { toPipelineProvider, type CompressionProvider, type PipelineProvider } from './provider';
import {
  CompressionCanceledError,
  CompressionProviderError,
  defaultCompressionOptions,
  type CompressionOptions,
  type CompressionTask
} from './types';
import { TaskQueue } from '../queues/task-queue';
import { validateInputSize } from './options';
import {
  defaultPipeline,
  batchStatus,
  isActive,
  type OutputState,
  type Pipeline,
  type WorkbenchBatch,
  type WorkbenchError
} from '../workbench/model';

/** 把临时结果交付到某个目的地；默认 download 直接视为就绪（由 UI 触发真实下载） */
export type OutputWriter = (
  item: CompressionTask,
  destination: OutputDestination,
  temp: TempFile
) => Promise<{ url?: string } | void>;

export interface CompressionSessionOptions {
  adapter: FileAdapter;
  provider: CompressionProvider | PipelineProvider;
  pipeline?: Pipeline;
  mode?: ProcessingPolicy;
  options?: Partial<CompressionOptions>;
  /** 默认 LIMITS.concurrency（5） */
  concurrency?: number;
  writeOutput?: OutputWriter;
  onUpdate?: (tasks: readonly CompressionTask[]) => void;
}

const defaultWriter: OutputWriter = async (_item, destination) => {
  if (!PHASE1_DESTINATION_TYPES.includes(destination.type)) {
    throw new CompressionProviderError('OPERATION_UNSUPPORTED', '第一阶段只支持下载输出');
  }
};

/**
 * 本地会话：addFiles 只建草稿，不自动开始；run() / start() 才进队列。
 */
export class CompressionSession {
  readonly tasks: CompressionTask[] = [];
  readonly sessionId: string;
  readonly batch: WorkbenchBatch;
  private readonly controllers = new Map<string, AbortController>();
  private readonly queue: TaskQueue;
  private readonly options: CompressionOptions;
  private readonly adapter: FileAdapter;
  private readonly provider: PipelineProvider;
  private readonly writeOutput: OutputWriter;
  private readonly onUpdate?: (tasks: readonly CompressionTask[]) => void;

  constructor(options: CompressionSessionOptions) {
    this.adapter = options.adapter;
    this.provider = toPipelineProvider(options.provider);
    this.options = { ...defaultCompressionOptions, ...options.options };
    this.queue = new TaskQueue(options.concurrency ?? LIMITS.concurrency);
    this.writeOutput = options.writeOutput ?? defaultWriter;
    this.onUpdate = options.onUpdate;
    this.sessionId = createSessionId();
    this.batch = {
      id: this.sessionId,
      mode: options.mode ?? 'private-local',
      pipeline: options.pipeline ?? defaultPipeline(),
      status: 'draft',
      itemIds: []
    };
  }

  get pipeline(): Pipeline {
    return this.batch.pipeline;
  }

  /** 草稿期可修改操作链 */
  setPipeline(pipeline: Pipeline): void {
    this.batch.pipeline = pipeline;
    for (const task of this.tasks) {
      if (task.status === 'draft') task.outputs = this.createOutputs(task.id);
    }
    this.emitUpdate();
  }

  get draftCount(): number {
    return this.tasks.filter(task => task.status === 'draft').length;
  }

  addFiles(files: readonly SourceFile[]): readonly CompressionTask[] {
    for (const file of files) {
      const id = this.sessionId + '-' + String(this.tasks.length) + '-' + file.id;
      this.tasks.push({
        id,
        batchId: this.batch.id,
        mode: this.batch.mode,
        source: { kind: 'file', file },
        status: 'draft',
        progress: 0,
        attempts: 0,
        originalSize: file.size,
        outputs: this.createOutputs(id)
      });
      this.batch.itemIds.push(id);
    }
    this.emitUpdate();
    return this.tasks;
  }

  /** 用户点“开始处理”：把所有草稿放入队列，等全部结束 */
  async run(): Promise<readonly CompressionTask[]> {
    const drafts = this.tasks.filter(task => task.status === 'draft');
    for (const task of drafts) task.status = 'queued';
    this.emitUpdate();
    await Promise.all(drafts.map(task => this.runTask(task)));
    return this.tasks;
  }

  start(): Promise<readonly CompressionTask[]> {
    return this.run();
  }

  async retry(taskId: string, scope: 'all' | 'outputs' = 'all'): Promise<CompressionTask | undefined> {
    const task = this.tasks.find(item => item.id === taskId);
    if (!task) return task;
    if (scope === 'outputs') {
      if (!task.output || !task.outputs.some(o => o.status === 'failed')) return task;
      task.status = 'saving';
      task.error = undefined;
      this.emitUpdate();
      try {
        const temp = task.tempFile ?? await this.prepareOutput(task);
        await this.deliver(task, temp, o => o.status === 'failed');
      } catch (error) {
        this.applyFailure(task, error);
      }
      this.emitUpdate();
      return task;
    }
    if (task.status !== 'failed' && task.status !== 'canceled' && !task.outputs.some(o => o.status === 'failed')) return task;
    task.status = 'queued';
    task.progress = 0;
    task.error = undefined;
    task.output = undefined;
    task.tempFile = undefined;
    task.compressedSize = undefined;
    task.outputs = this.createOutputs(task.id);
    this.emitUpdate();
    await this.runTask(task);
    return task;
  }

  /** 移除草稿或终态条目；进行中的不能移除 */
  remove(taskId: string): boolean {
    const index = this.tasks.findIndex(item => item.id === taskId);
    const task = this.tasks[index];
    if (!task || isActive(task.status)) return false;
    this.tasks.splice(index, 1);
    this.batch.itemIds = this.batch.itemIds.filter(id => id !== taskId);
    this.emitUpdate();
    return true;
  }

  /** 草稿直接变 canceled；进行中的中止 */
  cancel(taskId: string): void {
    const task = this.tasks.find(item => item.id === taskId);
    if (task?.status === 'draft') {
      this.markCanceled(task, new CompressionCanceledError());
      this.emitUpdate();
      return;
    }
    this.controllers.get(taskId)?.abort(new CompressionCanceledError());
  }

  cancelAll(): void {
    for (const task of this.tasks) if (task.status === 'draft') this.markCanceled(task, new CompressionCanceledError());
    for (const controller of this.controllers.values()) {
      controller.abort(new CompressionCanceledError());
    }
    this.queue.cancelAll(new CompressionCanceledError());
    this.emitUpdate();
  }

  async cleanup(sessionId: string): Promise<void> {
    await this.adapter.cleanup(sessionId);
  }

  private createOutputs(taskId: string): OutputState[] {
    return this.batch.pipeline.destinations.map((destination, index) => ({
      outputId: taskId + '-out-' + String(index),
      destination: { ...destination },
      status: 'pending'
    }));
  }

  private async runTask(task: CompressionTask): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);

    try {
      await this.queue.add(({ signal }) => this.processTask(task, signal), { signal: controller.signal });
    } catch (error) {
      this.applyFailure(task, error);
    } finally {
      this.controllers.delete(task.id);
      this.emitUpdate();
    }
  }

  private async processTask(task: CompressionTask, signal: AbortSignal): Promise<void> {
    const file = task.source.kind === 'file' ? task.source.file : undefined;
    if (!file) throw new CompressionProviderError('VALIDATION_FAILED', '本地模式不支持 URL 输入');
    task.attempts += 1;
    try {
      validateInputSize(file.size, this.options);
    } catch (error) {
      throw new CompressionProviderError('FILE_TOO_LARGE', error instanceof Error ? error.message : '图片超过单文件大小限制', error);
    }
    // 本地映射：读文件 = uploading，编码 = processing，写临时/交付 = saving
    this.setStatus(task, 'uploading', 0.05);
    const input = await this.adapter.read(file);
    this.throwIfCanceled(signal);

    this.setStatus(task, 'processing', 0.1);
    const output = await this.provider.process(input, this.batch.pipeline.operations, { ...this.options, inputMime: file.mime }, signal);
    this.throwIfCanceled(signal);

    this.setStatus(task, 'saving', 0.9);
    // Provider 一成功就保留结果，磁盘写入失败后只重试保存，不能再次压缩。
    task.output = output;
    task.compressedSize = output.size;
    const tempFile = await this.prepareOutput(task);
    this.throwIfCanceled(signal);

    await this.deliver(task, tempFile, () => true);
  }

  private async prepareOutput(task: CompressionTask): Promise<TempFile> {
    const result = task.output!;
    const filename = task.source.kind === 'file' ? task.source.file.name : 'image';
    try {
      const temp = await this.adapter.writeTemp(task.id, result.bytes, extensionFromMime(result.mime, filename), result.mime);
      task.tempFile = temp;
      return temp;
    } catch (error) {
      for (const output of task.outputs) {
        if (output.status === 'completed') continue;
        output.status = 'failed';
        output.error = { code: 'OUTPUT_FAILED', message: error instanceof Error ? error.message : '保存结果失败' };
      }
      throw new CompressionProviderError('OUTPUT_FAILED', '处理成功，但保存输出失败', error);
    }
  }

  /** 逐个目的地交付；全部失败 → failed，否则 completed（派生状态可能是 partial） */
  private async deliver(task: CompressionTask, temp: TempFile, pick: (o: OutputState) => boolean): Promise<void> {
    for (const output of task.outputs.filter(pick)) {
      output.status = 'saving';
      output.error = undefined;
      try {
        const res = await this.writeOutput(task, output.destination, temp);
        output.status = 'completed';
        if (res && res.url) output.url = res.url;
      } catch (error) {
        output.status = 'failed';
        output.error = { ...normalizeError(error), code: 'OUTPUT_FAILED' };
      }
    }
    const anyOk = task.outputs.some(o => o.status === 'completed');
    task.progress = 1;
    if (task.outputs.length > 0 && !anyOk) {
      task.status = 'failed';
      task.error = { code: 'OUTPUT_FAILED', message: '处理成功，但保存输出失败' };
    } else {
      task.status = 'completed';
    }
  }

  private setStatus(task: CompressionTask, status: CompressionTask['status'], progress: number): void {
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'canceled') return;
    task.status = status;
    task.progress = progress;
    this.emitUpdate();
  }

  private markCanceled(task: CompressionTask, cause: unknown): void {
    task.status = 'canceled';
    task.progress = 0;
    task.error = { code: 'CANCELED', message: '压缩任务已取消', cause };
  }

  private applyFailure(task: CompressionTask, error: unknown): void {
    if (error instanceof CompressionCanceledError || isAbortError(error)) {
      this.markCanceled(task, error);
      return;
    }
    task.status = 'failed';
    task.error = normalizeError(error);
  }

  private throwIfCanceled(signal: AbortSignal): void {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new CompressionCanceledError();
    }
  }

  private emitUpdate(): void {
    this.batch.status = batchStatus(this.tasks);
    this.onUpdate?.(this.tasks);
  }
}

export { isActive };

function extensionFromMime(mime: string, fallbackName: string): string {
  const extension = mime.split('/')[1]?.split(';')[0];
  if (extension) return extension === 'jpeg' ? 'jpg' : extension;
  return fallbackName.split('.').pop() ?? 'bin';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function normalizeError(error: unknown): WorkbenchError {
  if (error instanceof CompressionProviderError) {
    return { code: error.code, message: error.message, cause: error.cause };
  }
  if (error instanceof Error) {
    return { code: 'UNKNOWN', message: error.message, cause: error };
  }
  return { code: 'UNKNOWN', message: '压缩失败，请稍后重试', cause: error };
}

function createSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return String(Date.now()) + '-' + Math.random().toString(36).slice(2);
}
