import { describe, expect, it } from 'vitest';
import { formatBytes, sizeChange, statusLabel } from '../../src/core/lite/presentation';
import type { LiteItem } from '../../src/core/lite/session';

describe('readable image feedback', () => {
  it('uses a positive increase label when an output is larger', () => {
    expect(sizeChange(1000, 1250)).toEqual({ text: '增加 25%', tone: 'increase' });
    expect(sizeChange(1000, 600)).toEqual({ text: '减少 40%', tone: 'saving' });
    expect(sizeChange(1000, 1000)).toEqual({ text: '大小不变', tone: 'neutral' });
  });
  it('formats small files and decimal megabytes without invalid values', () => {
    expect(formatBytes(400)).toBe('400 B');
    expect(formatBytes(20_000_000)).toBe('20 MB');
    expect(formatBytes(0)).toBe('0 B');
  });
  it('announces a pending cancel and real upload/download stages', () => {
    const item = { status: 'processing', cancelPending: true, stage: 'uploading' } as LiteItem;
    expect(statusLabel(item)).toBe('正在取消');
    item.cancelPending = false;
    expect(statusLabel(item)).toBe('正在上传');
    item.stage = 'downloading'; expect(statusLabel(item)).toBe('正在下载');
    item.status = 'canceled'; expect(statusLabel(item)).toBe('已取消');
  });
});
