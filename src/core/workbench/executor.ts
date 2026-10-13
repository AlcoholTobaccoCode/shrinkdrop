import type { ProcessingPolicy } from '@tinypng/shared';
import type { SourceFile } from '../files/contracts';
import type { Pipeline, WorkbenchItem } from './model';

/** 本地与云端同一套执行器接口（D3 LocalExecutor / D4 CloudExecutor） */
export interface Executor {
  readonly mode: ProcessingPolicy;
  /** 只建草稿，绝不自动开始 */
  addFiles(files: readonly SourceFile[]): void;
  /** 云端才支持；本地抛错 */
  addUrls?(urls: readonly string[]): void;
  setPipeline(pipeline: Pipeline): void;
  start(): Promise<void>;
  cancel(itemId: string): void | Promise<void>;
  cancelAll(): void | Promise<void>;
  retry(itemId: string, scope: 'all' | 'outputs'): Promise<void>;
  remove(itemId: string): boolean;
  /** 订阅条目变化，返回取消订阅 */
  subscribe(listener: (items: readonly WorkbenchItem[]) => void): () => void;
  dispose(): Promise<void>;
  /** 结果字节（预览/单张下载）；没有结果返回 undefined */
  resultBlob?(itemId: string): Promise<Blob | undefined>;
  /** 仅打包成功结果；AbortSignal 取消下载，不取消处理任务。 */
  downloadArchive?(signal?: AbortSignal): Promise<{ blob: Blob; filename: string }>;
  /** 原图字节（预览） */
  sourceBlob?(itemId: string): Promise<Blob | undefined>;
}
