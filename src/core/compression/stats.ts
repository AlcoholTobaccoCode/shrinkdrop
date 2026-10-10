import type { CompressionTask } from './types';

export interface CompressionStats {
  total: number;
  pending: number;
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
  const completed = tasks.filter(task => task.status === 'completed').length;
  const failed = tasks.filter(task => task.status === 'failed').length;
  const canceled = tasks.filter(task => task.status === 'canceled').length;
  const pending = tasks.filter(task => task.status === 'pending').length;
  const active = tasks.filter(task =>
    task.status === 'reading' || task.status === 'compressing' || task.status === 'writing'
  ).length;
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
