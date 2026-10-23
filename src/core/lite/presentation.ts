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

import { t } from '../i18n';

export function statusLabel(item: LiteItem): string {
  if (item.cancelPending) return t('正在取消');
  if (item.status === 'processing') {
    const label = t({ uploading: '正在上传', processing: '等待压缩结果', downloading: '正在下载', verifying: '正在校验' }[item.stage ?? 'uploading']);
    if ((item.stage === 'uploading' || item.stage === 'downloading')
      && item.transferTotal && item.transferred !== undefined) {
      return `${label} ${Math.floor(item.transferred / item.transferTotal * 100)}%`;
    }
    if (item.stage === 'processing' && item.stageSeconds) {
      return t('等待压缩结果 · 已等待 {n} 秒', { n: item.stageSeconds });
    }
    return label;
  }
  if (item.overwriting) return t('正在确认并覆盖');
  if (item.status === 'completed' && item.overwritten) return t('已覆盖原图');
  if (item.status === 'completed' && item.saved) return t('已保存');
  return t({ draft: '待开始', queued: '等待压缩', completed: '已完成', canceled: '已取消', failed: '压缩失败' }[item.status]);
}
