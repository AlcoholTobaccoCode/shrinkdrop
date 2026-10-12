import { describe, expect, it } from 'vitest';
import { queueItemView } from '../../src/core/workbench/queue-view';
import type { WorkbenchItem } from '../../src/core/workbench/model';

const base: WorkbenchItem = {
  id: 'i', batchId: 'b', mode: 'cloud', source: { kind: 'url', url: 'https://x/a.png' },
  status: 'draft', progress: 0, attempts: 0, originalSize: 1000, outputs: [{ outputId: 'o', destination: { type: 'download' }, status: 'pending' }]
};
const result = { bytes: new Uint8Array(1), mime: 'image/png', size: 400, width: 1, height: 1, ratio: 0.4 };

describe('队列项 8 种展示状态（interaction-specs 2.1）', () => {
  it.each([
    [{}, 'draft', ['remove']],
    [{ status: 'queued' }, 'queued', ['cancel']],
    [{ status: 'processing', progress: 0.5, attempts: 1 }, 'running', ['cancel']],
    [{ status: 'completed', output: result, compressedSize: 400, outputs: [{ outputId: 'o', destination: { type: 'download' }, status: 'completed' }] }, 'completed', ['download']],
    [{ status: 'completed', output: result, outputs: [{ outputId: 'o', destination: { type: 'download' }, status: 'completed' }, { outputId: 'p', destination: { type: 'download' }, status: 'failed' }] }, 'partial', ['retry-outputs', 'download']],
    [{ status: 'failed', output: result, outputs: [{ outputId: 'o', destination: { type: 'download' }, status: 'failed' }] }, 'output-failed', ['retry-outputs']],
    [{ status: 'failed', error: { code: 'PROVIDER_ERROR', message: 'boom' } }, 'failed', ['retry']],
    [{ status: 'canceled' }, 'canceled', ['retry']]
  ] as const)('%#', (patch, state, actions) => {
    const view = queueItemView({ ...base, ...(patch as Partial<WorkbenchItem>) }, 2);
    expect(view.state).toBe(state);
    expect(view.actions).toEqual(actions);
  });

  it('文案：排队位置、运行进度与尝试次数、output-failed 旁注', () => {
    expect(queueItemView({ ...base, status: 'queued' }, 3).text).toBe('排队中 · 第 3 位');
    expect(queueItemView({ ...base, status: 'saving', progress: 0.9, attempts: 2 }).text).toBe('保存中 · 90% · 尝试 2/3');
    expect(queueItemView({ ...base, mode: 'private-local', status: 'uploading', progress: 0.05, attempts: 1 }).text).toContain('读取中');
    expect(queueItemView({ ...base, status: 'failed', output: result, outputs: [{ outputId: 'o', destination: { type: 'download' }, status: 'failed' }] }).note).toBe('不消耗额度');
    expect(queueItemView({ ...base, status: 'completed', output: result, compressedSize: 400, outputs: [{ outputId: 'o', destination: { type: 'download' }, status: 'completed' }] }).text).toBe('节省 60.0%');
  });
});
