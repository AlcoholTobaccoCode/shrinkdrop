import { LIMITS } from '@tinypng/shared';
import { canRetryOutputs, displayStatus, type WorkbenchItem } from './model';

/** 队列项 8 种展示状态（interaction-specs 2.1） */
export type QueueState = 'draft' | 'queued' | 'running' | 'completed' | 'partial' | 'output-failed' | 'failed' | 'canceled';
export type QueueAction = 'remove' | 'cancel' | 'retry' | 'retry-outputs' | 'download';

export interface QueueItemView {
  state: QueueState;
  text: string;
  actions: QueueAction[];
  /** output-failed 旁注 */
  note?: string;
  progress?: number;
}

const runningText = { uploading: '上传中', processing: '处理中', saving: '保存中' } as const;

export function queueItemView(item: WorkbenchItem, position?: number, local = item.mode === 'private-local'): QueueItemView {
  const shown = displayStatus(item);
  switch (shown) {
    case 'draft':
      return { state: 'draft', text: '草稿 · 待开始', actions: ['remove'] };
    case 'queued':
      return { state: 'queued', text: position ? '排队中 · 第 ' + String(position) + ' 位' : '排队中', actions: ['cancel'] };
    case 'uploading':
    case 'processing':
    case 'saving': {
      const label = local && shown === 'uploading' ? '读取中' : runningText[shown];
      return {
        state: 'running',
        text: label + ' · ' + String(Math.round(item.progress * 100)) + '% · 尝试 ' + String(Math.max(1, item.attempts)) + '/' + String(1 + LIMITS.maxRetries),
        actions: ['cancel'],
        progress: item.progress
      };
    }
    case 'completed': {
      const saved = item.compressedSize !== undefined && item.originalSize > 0
        ? Math.max(0, (1 - item.compressedSize / item.originalSize) * 100).toFixed(1)
        : '0.0';
      return { state: 'completed', text: '节省 ' + saved + '%', actions: ['download'] };
    }
    case 'partial': {
      const failed = item.outputs.filter(o => o.status === 'failed').length;
      return { state: 'partial', text: '已处理 · ' + String(failed) + ' 个目的地失败', actions: ['retry-outputs', 'download'] };
    }
    case 'output-failed':
      return { state: 'output-failed', text: '已处理，保存失败', actions: ['retry-outputs'], note: '不消耗额度' };
    case 'failed':
      return {
        state: 'failed',
        text: '处理失败：' + (item.error?.message ?? '未知错误'),
        // 有结果且输出失败时也给“重试输出”（与派生状态无关）
        actions: canRetryOutputs(item) ? ['retry', 'retry-outputs'] : ['retry']
      };
    case 'canceled':
      return { state: 'canceled', text: '已取消', actions: ['retry'] };
  }
}
