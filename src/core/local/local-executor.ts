import { LIMITS } from '@tinypng/shared';
import type { FileAdapter, SourceFile } from '../files/contracts';
import { archiveResults } from '../files/downloads';
import { CompressionSession, type OutputWriter } from '../compression/session';
import type { CompressionProvider, PipelineProvider } from '../compression/provider';
import type { Executor } from '../workbench/executor';
import type { Pipeline, WorkbenchItem } from '../workbench/model';
import { CanvasPipelineProvider } from './canvas-provider';
import { NetworkGuard } from './network-guard';

export interface LocalExecutorOptions {
  adapter: FileAdapter;
  pipeline: Pipeline;
  provider?: CompressionProvider | PipelineProvider;
  /** 默认 LIMITS.concurrency（5），复用 TaskQueue */
  concurrency?: number;
  writeOutput?: OutputWriter;
  guard?: NetworkGuard;
}

/** 本地私有模式执行器：Canvas 处理，处理期间开启网络护栏 */
export class LocalExecutor implements Executor {
  readonly mode = 'private-local' as const;
  readonly guard: NetworkGuard;
  private readonly session: CompressionSession;
  private readonly adapter: FileAdapter;
  private readonly listeners = new Set<(items: readonly WorkbenchItem[]) => void>();

  constructor(options: LocalExecutorOptions) {
    this.guard = options.guard ?? new NetworkGuard();
    this.adapter = options.adapter;
    this.session = new CompressionSession({
      adapter: options.adapter,
      provider: options.provider ?? new CanvasPipelineProvider(),
      pipeline: { ...options.pipeline, providerId: 'local' },
      mode: 'private-local',
      concurrency: options.concurrency ?? LIMITS.concurrency,
      writeOutput: options.writeOutput,
      onUpdate: items => this.listeners.forEach(listener => listener(items))
    });
  }

  get items(): readonly WorkbenchItem[] {
    return this.session.tasks;
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  addFiles(files: readonly SourceFile[]): void {
    this.session.addFiles(files);
  }

  addUrls(): void {
    throw new Error('本地私有模式不支持 URL 输入');
  }

  setPipeline(pipeline: Pipeline): void {
    this.session.setPipeline({ ...pipeline, providerId: 'local' });
  }

  async start(): Promise<void> {
    await this.guard.run(() => this.session.run());
  }

  cancel(itemId: string): void {
    this.session.cancel(itemId);
  }

  cancelAll(): void {
    this.session.cancelAll();
  }

  async retry(itemId: string, scope: 'all' | 'outputs'): Promise<void> {
    await this.guard.run(() => this.session.retry(itemId, scope));
  }

  remove(itemId: string): boolean {
    return this.session.remove(itemId);
  }

  subscribe(listener: (items: readonly WorkbenchItem[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.session.tasks);
    return () => this.listeners.delete(listener);
  }

  async resultBlob(itemId: string): Promise<Blob | undefined> {
    const item = this.session.tasks.find(i => i.id === itemId);
    if (!item?.output) return undefined;
    return new Blob([item.output.bytes.slice().buffer as ArrayBuffer], { type: item.output.mime });
  }

  async sourceBlob(itemId: string): Promise<Blob | undefined> {
    const item = this.session.tasks.find(i => i.id === itemId);
    if (item?.source.kind !== 'file') return undefined;
    const bytes = await this.adapter.read(item.source.file);
    return new Blob([bytes.slice().buffer as ArrayBuffer], { type: item.source.file.mime });
  }

  async downloadArchive(signal?: AbortSignal): Promise<{ blob: Blob; filename: string }> {
    return { blob: await archiveResults(this.session.tasks, signal), filename: 'images-' + this.sessionId.slice(0, 8) + '.zip' };
  }

  async dispose(): Promise<void> {
    this.session.cancelAll();
    this.listeners.clear();
    await this.session.cleanup(this.session.sessionId);
  }
}
