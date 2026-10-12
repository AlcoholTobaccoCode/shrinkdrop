import type {
  ApiErrorCode,
  BatchStatus,
  JobDisplayStatus,
  JobOutput,
  JobStatus,
  Operation,
  OutputDestination,
  ProcessingPolicy,
  ProviderId
} from '@tinypng/shared';
import { TERMINAL_JOB_STATUSES, deriveBatchStatus as deriveSharedBatchStatus, deriveDisplayStatus } from '@tinypng/shared';
import type { SourceFile, TempFile } from '../files/contracts';

/** 操作链 = 一个批次的处理方案 */
export interface Pipeline {
  providerId: ProviderId;
  /** 有序，按顺序执行 */
  operations: Operation[];
  destinations: OutputDestination[];
}

export const defaultPipeline = (): Pipeline => ({
  providerId: 'local',
  operations: [{ type: 'compress' }],
  destinations: [{ type: 'download' }]
});

/** 本地专有的错误码，云端错误码直接用 ApiErrorCode */
export type LocalErrorCode = 'CANCELED' | 'UNSUPPORTED_FORMAT' | 'PIXELS_TOO_LARGE' | 'READ_FAILED' | 'WRITE_FAILED' | 'UNKNOWN';
export type WorkbenchErrorCode = ApiErrorCode | LocalErrorCode;

export interface WorkbenchError {
  code: WorkbenchErrorCode;
  message: string;
  cause?: unknown;
}

/** 每个输出目的地单独记录（与 Server JobOutput 同构，error 放宽为客户端错误） */
export interface OutputState extends Omit<JobOutput, 'error'> {
  error?: WorkbenchError;
}

export type ItemSource =
  | { kind: 'file'; file: SourceFile; previewUrl?: string }
  | { kind: 'url'; url: string };

export interface ProcessedResult {
  bytes: Uint8Array;
  mime: string;
  size: number;
  width: number;
  height: number;
  /** 输出/输入体积比 */
  ratio: number;
}

/** 客户端视角的一张图（本地/云端统一）；云端 id = jobId */
export interface WorkbenchItem {
  id: string;
  batchId: string;
  mode: ProcessingPolicy;
  source: ItemSource;
  status: JobStatus;
  /** 0–1 */
  progress: number;
  attempts: number;
  originalSize: number;
  compressedSize?: number;
  /** Provider 处理结果（本地）；存在即表示 Provider 已成功 */
  output?: ProcessedResult;
  tempFile?: TempFile;
  outputs: OutputState[];
  error?: WorkbenchError;
}

export interface WorkbenchBatch {
  id: string;
  mode: ProcessingPolicy;
  pipeline: Pipeline;
  /** draft 时不自动处理，用户点“开始处理”才进队列 */
  status: BatchStatus;
  itemIds: string[];
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

export function isActive(status: JobStatus): boolean {
  return status === 'queued' || status === 'uploading' || status === 'processing' || status === 'saving';
}

/** 展示状态：共享包推导（partial / output-failed / failed），hasResult 取本地是否已有结果 */
export type DisplayStatus = JobDisplayStatus;

export function displayStatus(item: Pick<WorkbenchItem, 'status' | 'outputs' | 'output'>): DisplayStatus {
  return deriveDisplayStatus({ status: item.status, outputs: item.outputs, hasResult: item.output !== undefined });
}

/**
 * 是否显示“只重试输出”：只要 Provider 已产出结果且有输出失败就显示，
 * 与派生状态无关（单输出失败时派生状态是 failed，也要能只重试输出）。
 */
export function canRetryOutputs(item: Pick<WorkbenchItem, 'output' | 'outputs'>): boolean {
  return item.output !== undefined && item.outputs.some(output => output.status === 'failed');
}

export function sourceFile(item: Pick<WorkbenchItem, 'source'>): SourceFile | undefined {
  return item.source.kind === 'file' ? item.source.file : undefined;
}

export function batchStatus(items: readonly Pick<WorkbenchItem, 'status' | 'outputs' | 'output'>[]): BatchStatus {
  return deriveSharedBatchStatus(items.map(item => ({ status: item.status, outputs: item.outputs, hasResult: item.output !== undefined })));
}
