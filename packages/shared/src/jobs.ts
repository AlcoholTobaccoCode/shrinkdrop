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

/** 界面展示状态：在 JobStatus 基础上推导“部分成功”，Server 状态机不变 */
export type JobDisplayStatus = JobStatus | 'partial';

export function deriveDisplayStatus(job: Pick<Job, 'status' | 'outputs'>): JobDisplayStatus {
  if (job.status !== 'completed' && job.status !== 'failed') return job.status;
  const done = job.outputs.filter((o) => o.status === 'completed').length;
  const failed = job.outputs.filter((o) => o.status === 'failed').length;
  if (done > 0 && failed > 0) return 'partial';
  return job.status;
}
