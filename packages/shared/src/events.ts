import type { JobOutput, JobStatus, BatchStatus } from './jobs';
import type { ApiError } from './errors';

/** GET /batches/:id/events 的 SSE data 载荷（增量），event 名与 type 相同 */
export type BatchEvent =
  | { type: 'job'; jobId: string; status: JobStatus; progress?: number; outputs?: JobOutput[]; error?: ApiError }
  | { type: 'batch'; batchId: string; status: BatchStatus }
  | { type: 'heartbeat'; at: string };

/** Server 每 15 秒发一次 heartbeat */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
