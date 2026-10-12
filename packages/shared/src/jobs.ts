import type { ApiError } from './errors';
import type { Operation, OutputDestination } from './operations';
import type { ProviderId } from './providers';

export const JOB_STATUSES = [
  'draft', 'queued', 'uploading', 'processing', 'saving', 'completed', 'failed', 'canceled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'canceled'];

export type BatchStatus = 'draft' | 'running' | 'completed' | 'partial' | 'failed' | 'canceled';
export type OutputStatus = 'pending' | 'saving' | 'completed' | 'failed';

export interface ImageInfo { mime: string; size: number; width: number; height: number }

export type JobSource =
  | { kind: 'upload'; filename: string; size: number }
  | { kind: 'url'; host: string; url: string };

export interface JobOutput {
  outputId: string;
  destination: OutputDestination;
  status: OutputStatus;
  url?: string;
  error?: ApiError;
}

export interface Job {
  jobId: string;
  batchId: string;
  source: JobSource;
  providerId: ProviderId;
  accountId?: string; // 匿名线路为 'anonymous'
  status: JobStatus;
  /** 0–1，仅 uploading/processing/saving 时有意义 */
  progress?: number;
  attempts: number;
  input?: ImageInfo;
  result?: ImageInfo & { savedRatio: number };
  outputs: JobOutput[];
  error?: ApiError;
  createdAt: string;
  updatedAt: string;
}

export interface Batch {
  batchId: string;
  providerId: ProviderId;
  operations: Operation[];
  destinations: OutputDestination[];
  status: BatchStatus;
  jobs: Job[];
  createdAt: string;
  updatedAt: string;
}

// ---- 请求体 ----
export interface CreateBatchRequest {
  providerId: ProviderId;
  operations: Operation[];
  destinations: OutputDestination[];
}
export interface AddUrlItemsRequest { urls: string[] }
export interface RetryJobRequest { scope: 'all' | 'outputs' }

/** 界面展示状态：在 JobStatus 基础上推导，Server 状态机不变
 * - partial：有结果，输出部分成功部分失败
 * - output-failed：有结果，但输出全部失败（可“重试输出”，不消耗额度）
 * - failed：Provider 本身处理失败
 */
export type JobDisplayStatus = JobStatus | 'partial' | 'output-failed';

export interface DisplayStatusInput {
  status: JobStatus;
  outputs: ReadonlyArray<{ status: OutputStatus }>;
  /** 是否已有 Provider 结果；不传时按 status === 'completed' 判断 */
  hasResult?: boolean;
}

export function deriveDisplayStatus(job: DisplayStatusInput): JobDisplayStatus {
  if (job.status !== 'completed' && job.status !== 'failed') return job.status;
  const hasResult = job.hasResult ?? job.status === 'completed';
  if (!hasResult) return job.status;
  const total = job.outputs.length;
  const done = job.outputs.filter((o) => o.status === 'completed').length;
  const failed = job.outputs.filter((o) => o.status === 'failed').length;
  if (total > 0 && failed === total) return 'output-failed';
  if (done > 0 && failed > 0) return 'partial';
  return failed > 0 ? 'output-failed' : 'completed';
}

/** 批次展示状态：由各任务的展示状态汇总 */
export function deriveBatchStatus(jobs: ReadonlyArray<DisplayStatusInput>): BatchStatus {
  if (jobs.length === 0) return 'draft';
  const s = jobs.map(deriveDisplayStatus);
  if (s.some((x) => x === 'queued' || x === 'uploading' || x === 'processing' || x === 'saving')) return 'running';
  if (s.every((x) => x === 'draft')) return 'draft';
  if (s.some((x) => x === 'draft')) return 'running';
  if (s.every((x) => x === 'canceled')) return 'canceled';
  const ok = s.filter((x) => x === 'completed').length;
  if (ok === s.length) return 'completed';
  if (ok === 0 && s.every((x) => x === 'failed' || x === 'canceled')) return 'failed';
  return 'partial';
}
