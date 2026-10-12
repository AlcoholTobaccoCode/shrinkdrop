import type { WorkbenchErrorCode, WorkbenchItem, ProcessedResult } from '../workbench/model';

export type { JobStatus as CompressionStatus } from '@tinypng/shared';
export type CompressionErrorCode = WorkbenchErrorCode;

export interface CompressionOptions {
  quality: number;
  maxFileBytes: number;
  maxPixels: number;
  preserveMetadata: boolean;
  inputMime?: string;
  /** convert 操作指定的输出格式 */
  outputMime?: string;
}

export const defaultCompressionOptions: CompressionOptions = {
  quality: 0.82,
  maxFileBytes: 20 * 1024 * 1024,
  maxPixels: 40_000_000,
  preserveMetadata: false
};

export type CompressionOutput = ProcessedResult;

/** 兼容旧名：任务即工作台条目 */
export type CompressionTask = WorkbenchItem;

export class CompressionCanceledError extends Error {
  readonly code = 'CANCELED' as const;

  constructor(message = '压缩任务已取消') {
    super(message);
    this.name = 'CompressionCanceledError';
  }
}

export class CompressionProviderError extends Error {
  readonly code: CompressionErrorCode;
  override readonly cause?: unknown;

  constructor(code: Exclude<CompressionErrorCode, 'CANCELED'>, message: string, cause?: unknown) {
    super(message);
    this.name = 'CompressionProviderError';
    this.code = code;
    this.cause = cause;
  }
}
