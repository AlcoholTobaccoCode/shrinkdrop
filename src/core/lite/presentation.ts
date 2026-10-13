import type { LiteItem } from './session';

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const unit = bytes >= 1_000_000 ? 'MB' : 'KB';
  const value = bytes / (unit === 'MB' ? 1_000_000 : 1000);
  return `${Number(value.toFixed(1))} ${unit}`;
}

export function sizeChange(original: number, output: number) {
  if (original === output) return { text: '大小不变', tone: 'neutral' };
  const percent = Number((Math.abs(original - output) / original * 100).toFixed(1));
  return output > original
    ? { text: `增加 ${percent}%`, tone: 'increase' }
    : { text: `减少 ${percent}%`, tone: 'saving' };
}

export function statusLabel(item: LiteItem): string {
  if (item.cancelPending) return '正在取消';
  if (item.status === 'processing') return item.stage === 'downloading' ? '正在下载' : '正在上传';
  if (item.status === 'completed' && item.saved) return '已保存';
  return { draft: '待开始', queued: '等待压缩', completed: '已完成', canceled: '已取消', failed: '压缩失败' }[item.status];
}
