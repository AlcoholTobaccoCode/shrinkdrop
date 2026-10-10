import type { SourceFile, TempFile } from '../files/contracts';

export type CompressionStatus =
  | 'pending'
  | 'reading'
  | 'compressing'
  | 'writing'
  | 'completed'
  | 'failed'
  | 'canceled';

export type CompressionErrorCode =
  | 'CANCELED'
  | 'UNSUPPORTED_FORMAT'
  | 'FILE_TOO_LARGE'
  | 'PIXELS_TOO_LARGE'
  | 'READ_FAILED'
  | 'WRITE_FAILED'
  | 'PROVIDER_FAILED'
  | 'UNKNOWN';

export interface CompressionOptions {
  quality: number;
  maxFileBytes: number;
  maxPixels: number;
  preserveMetadata: boolean;
  inputMime?: string;
}

export const defaultCompressionOptions: CompressionOptions = {
  quality: 0.82,
  maxFileBytes: 50 * 1024 * 1024,
  maxPixels: 40_000_000,
  preserveMetadata: false
};

export interface CompressionOutput {
  bytes: Uint8Array;
  mime: string;
  size: number;
  width: number;
  height: number;
  ratio: number;
}

export interface CompressionTask {
  id: string;
  source: SourceFile;
  status: CompressionStatus;
  progress: number;
  originalSize: number;
  compressedSize?: number;
  output?: CompressionOutput;
  tempFile?: TempFile;
  error?: {
    code: CompressionErrorCode;
    message: string;
    cause?: unknown;
  };
}

export class CompressionCanceledError extends Error {
  readonly code = 'CANCELED' as const;

  constructor(message = '压缩任务已取消') {
    super(message);
    this.name = 'CompressionCanceledError';
  }
}

export class CompressionProviderError extends Error {
  readonly code: CompressionErrorCode;

  constructor(code: Exclude<CompressionErrorCode, 'CANCELED'>, message: string, cause?: unknown) {
    super(message);
    this.name = 'CompressionProviderError';
    this.code = code;
    this.cause = cause;
  }

  readonly cause?: unknown;
}
