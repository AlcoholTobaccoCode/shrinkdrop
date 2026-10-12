import type { CompressionTask } from './types';
import { displayStatus, isActive } from '../workbench/model';

export interface CompressionStats {
  total: number;
  pending: number;
  /** 草稿数，“开始处理 (n)” 用 */
  draft: number;
  partial: number;
  outputFailed: number;
  active: number;
  completed: number;
  failed: number;
  canceled: number;
  originalBytes: number;
  compressedBytes: number;
  savedBytes: number;
  ratio: number;
  progress: number;
}

export function calculateCompressionStats(tasks: readonly CompressionTask[]): CompressionStats {
  const total = tasks.length;
  const shown = tasks.map(displayStatus);
  const completed = shown.filter(status => status === 'completed').length;
  const partial = shown.filter(status => status === 'partial').length;
  const failed = shown.filter(status => status === 'failed').length;
  const outputFailed = shown.filter(status => status === 'output-failed').length;
  const draft = tasks.filter(task => task.status === 'draft').length;
  const canceled = tasks.filter(task => task.status === 'canceled').length;
  const pending = tasks.filter(task => task.status === 'queued').length;
  const active = tasks.filter(task => isActive(task.status) && task.status !== 'queued').length;
  const originalBytes = tasks.reduce((sum, task) => sum + task.originalSize, 0);
  const completedOriginalBytes = tasks.reduce(
    (sum, task) => sum + (task.status === 'completed' ? task.originalSize : 0),
    0
  );
  const compressedBytes = tasks.reduce(
    (sum, task) => sum + (task.status === 'completed' ? task.compressedSize ?? task.originalSize : 0),
    0
  );
  const savedBytes = Math.max(completedOriginalBytes - compressedBytes, 0);
  const ratio = completedOriginalBytes > 0 ? savedBytes / completedOriginalBytes : 0;
  const progress = total > 0 ? tasks.reduce((sum, task) => sum + task.progress, 0) / total : 0;

  return {
    total,
    pending,
    draft,
    partial,
    outputFailed,
    active,
    completed,
    failed,
    canceled,
    originalBytes,
    compressedBytes,
    savedBytes,
    ratio,
    progress
  };
}
