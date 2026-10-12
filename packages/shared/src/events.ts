import type { ImageInfo, JobOutput, JobStatus, BatchStatus } from './jobs';
import type { ApiError } from './errors';

/** GET /batches/:id/events 的 SSE data 载荷（增量），event 名与 type 相同 */
export type BatchEvent =
  | { type: 'job'; jobId: string; status: JobStatus; progress?: number; outputs?: JobOutput[]; error?: ApiError;
      /** status 为 completed（或已有结果）时必带 */
      result?: ImageInfo & { savedRatio: number } }
  | { type: 'batch'; batchId: string; status: BatchStatus }
  | { type: 'heartbeat'; at: string };

/** Server 每 15 秒发一次 heartbeat */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
