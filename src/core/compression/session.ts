import type { FileAdapter, SourceFile } from '../files/contracts';
import type { CompressionProvider } from './provider';
import {
  CompressionCanceledError,
  CompressionProviderError,
  defaultCompressionOptions,
  type CompressionOptions,
  type CompressionTask
} from './types';
import { TaskQueue } from '../queues/task-queue';
import { validateInputSize } from './options';

export interface CompressionSessionOptions {
  adapter: FileAdapter;
  provider: CompressionProvider;
  options?: Partial<CompressionOptions>;
  concurrency?: number;
  onUpdate?: (tasks: readonly CompressionTask[]) => void;
}

export class CompressionSession {
  readonly tasks: CompressionTask[] = [];
  readonly sessionId: string;
  private readonly controllers = new Map<string, AbortController>();
  private readonly queue: TaskQueue;
  private readonly options: CompressionOptions;
  private readonly adapter: FileAdapter;
  private readonly provider: CompressionProvider;
  private readonly onUpdate?: (tasks: readonly CompressionTask[]) => void;

  constructor(options: CompressionSessionOptions) {
    this.adapter = options.adapter;
    this.provider = options.provider;
    this.options = { ...defaultCompressionOptions, ...options.options };
    this.queue = new TaskQueue(options.concurrency ?? 3);
    this.onUpdate = options.onUpdate;
    this.sessionId = createSessionId();
  }

  addFiles(files: readonly SourceFile[]): readonly CompressionTask[] {
    for (const source of files) {
      this.tasks.push({
        id: this.sessionId + '-' + String(this.tasks.length) + '-' + source.id,
        source,
        status: 'pending',
        progress: 0,
        originalSize: source.size
      });
    }
    this.emitUpdate();
    return this.tasks;
  }

  async run(): Promise<readonly CompressionTask[]> {
    const pending = this.tasks.filter(task => task.status === 'pending');
    await Promise.all(pending.map(task => this.runTask(task)));
    return this.tasks;
  }

  async retry(taskId: string): Promise<CompressionTask | undefined> {
    const task = this.tasks.find(item => item.id === taskId);
    if (!task || (task.status !== 'failed' && task.status !== 'canceled')) return task;
    task.status = 'pending';
    task.progress = 0;
    task.error = undefined;
    task.output = undefined;
    task.tempFile = undefined;
    task.compressedSize = undefined;
    this.emitUpdate();
    await this.runTask(task);
    return task;
  }

  cancel(taskId: string): void {
    this.controllers.get(taskId)?.abort(new CompressionCanceledError());
  }

  cancelAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort(new CompressionCanceledError());
    }
    this.queue.cancelAll(new CompressionCanceledError());
  }

  async cleanup(sessionId: string): Promise<void> {
    await this.adapter.cleanup(sessionId);
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
    try {
      validateInputSize(task.source.size, this.options);
    } catch (error) {
      throw new CompressionProviderError('FILE_TOO_LARGE', error instanceof Error ? error.message : '图片超过单文件大小限制', error);
    }
    this.setStatus(task, 'reading', 0.05);
    const input = await this.adapter.read(task.source);
    this.throwIfCanceled(signal);

    this.setStatus(task, 'compressing', 0.1);
    const output = await this.provider.compress(input, { ...this.options, inputMime: task.source.mime }, signal);
    this.throwIfCanceled(signal);

    this.setStatus(task, 'writing', 0.9);
    const extension = extensionFromMime(output.mime, task.source.name);
    const tempFile = await this.adapter.writeTemp(task.id, output.bytes, extension, output.mime);
    this.throwIfCanceled(signal);

    task.output = output;
    task.tempFile = tempFile;
    task.compressedSize = output.size;
    this.setStatus(task, 'completed', 1);
  }

  private setStatus(task: CompressionTask, status: CompressionTask['status'], progress: number): void {
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'canceled') return;
    task.status = status;
    task.progress = progress;
    this.emitUpdate();
  }

  private applyFailure(task: CompressionTask, error: unknown): void {
    if (error instanceof CompressionCanceledError || isAbortError(error)) {
      task.status = 'canceled';
      task.progress = 0;
      task.error = { code: 'CANCELED', message: '压缩任务已取消', cause: error };
      return;
    }

    const normalized = normalizeError(error);
    task.status = 'failed';
    task.error = normalized;
    this.emitUpdate();
  }

  private throwIfCanceled(signal: AbortSignal): void {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new CompressionCanceledError();
    }
  }

  private emitUpdate(): void {
    this.onUpdate?.(this.tasks);
  }
}

function extensionFromMime(mime: string, fallbackName: string): string {
  const extension = mime.split('/')[1]?.split(';')[0];
  if (extension) return extension === 'jpeg' ? 'jpg' : extension;
  return fallbackName.split('.').pop() ?? 'bin';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function normalizeError(error: unknown): CompressionTask['error'] {
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
