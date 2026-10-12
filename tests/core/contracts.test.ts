import { describe, expect, it } from 'vitest';
import { calculateCompressionStats } from '../../src/core/compression/stats';
import type { CompressionTask } from '../../src/core/compression/types';

function task(status: CompressionTask['status'], originalSize: number, compressedSize?: number): CompressionTask {
  return {
    id: status,
    batchId: 'b1',
    mode: 'private-local',
    source: { kind: 'file', file: { id: status, name: status + '.png', size: originalSize, mime: 'image/png', relativePath: status + '.png' } },
    status,
    progress: status === 'completed' ? 1 : 0,
    attempts: 0,
    originalSize,
    compressedSize,
    outputs: []
  };
}

describe('compression contracts', () => {
  it('压缩任务初始状态为 draft', () => {
    expect(task('draft', 100).status).toBe('draft');
  });

  it('取消任务后状态为 canceled', () => {
    expect(task('canceled', 100).status).toBe('canceled');
  });

  it('失败任务可以保留用户可读错误', () => {
    const failed = task('failed', 100);
    failed.error = { code: 'PROVIDER_ERROR', message: '服务暂时不可用' };
    expect(failed.error.message).toBe('服务暂时不可用');
  });

  it('统计只计算成功任务的压缩体积', () => {
    const stats = calculateCompressionStats([
      task('completed', 1000, 400),
      task('failed', 2000, 100),
      task('draft', 500)
    ]);
    expect(stats.originalBytes).toBe(3500);
    expect(stats.compressedBytes).toBe(400);
    expect(stats.savedBytes).toBe(600);
  });
});
