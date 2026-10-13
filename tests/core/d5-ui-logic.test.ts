import { describe, expect, it } from 'vitest';
import { compareKey, nextZoom, zoomAt } from '../../src/core/ui/compare';
import { containHint, localPngHint, qualityHint } from '../../src/core/workbench/hints';
import type { Pipeline } from '../../src/core/workbench/model';

const p = (ops: Pipeline['operations']): Pipeline => ({ providerId: 'local', operations: ops, destinations: [{ type: 'download' }] });
const contain = { type: 'resize', width: 800, height: 600, fit: 'contain' } as const;

describe('对比滑块键盘（interaction-specs 1.3）', () => {
  it.each([
    ['ArrowLeft', false, 45], ['ArrowRight', false, 55], ['ArrowLeft', true, 49], ['ArrowRight', true, 51],
    ['PageDown', false, 25], ['PageUp', false, 75], ['Home', false, 0], ['End', false, 100], ['Enter', false, 50]
  ] as const)('%s shift=%s → %d', (key, shift, out) => {
    expect(compareKey(50, key, shift)).toBe(out);
  });
  it('边界夹紧，其他键不处理', () => {
    expect(compareKey(98, 'ArrowRight')).toBe(100);
    expect(compareKey(10, 'PageDown')).toBe(0);
    expect(compareKey(50, 'a')).toBeUndefined();
  });
  it('缩放档与以光标为中心缩放', () => {
    expect(nextZoom(1, 1)).toBe(1.5);
    expect(nextZoom(1, -1)).toBe(0.75);
    expect(nextZoom(8, 1)).toBe(8);
    expect(nextZoom(0.33, -1)).toBe(0.25);
    // 光标下的图像点在缩放前后不动
    const pan = zoomAt({ x: 10, y: 20 }, 1, 2, 110, 120);
    expect((110 - pan.x) / 2).toBe(110 - 10);
  });
});

describe('Inspector 提示（D5 TODO）', () => {
  it('contain 补边：PNG/WebP 透明，JPG 白色，混合两者都说', () => {
    expect(containHint(contain, p([contain]), ['image/png'])).toBe('补透明边到 800×600');
    expect(containHint(contain, p([contain]), ['image/jpeg'])).toBe('补白色边到 800×600');
    expect(containHint(contain, p([contain]), ['image/png', 'image/jpeg'])).toBe('补透明或白色边到 800×600（PNG/WebP 透明，JPG 白色）');
    expect(containHint(contain, p([contain, { type: 'convert', format: 'webp' }]), ['image/jpeg'])).toBe('补透明边到 800×600');
    expect(containHint({ ...contain, fit: 'cover' }, p([]), ['image/png'])).toBeUndefined();
    expect(containHint({ type: 'resize', width: 800, fit: 'contain' }, p([]), ['image/png'])).toBeUndefined();
  });

  it('本地 + 压缩 + PNG 输出才提示建议云端', () => {
    expect(localPngHint('private-local', p([{ type: 'compress' }]), ['image/png'])).toBe('本地模式对 PNG 压缩效果有限，建议用云端');
    expect(localPngHint('cloud', p([{ type: 'compress' }]), ['image/png'])).toBeUndefined();
    expect(localPngHint('private-local', p([{ type: 'compress' }, { type: 'convert', format: 'webp' }]), ['image/png'])).toBeUndefined();
    expect(localPngHint('private-local', p([{ type: 'compress' }, { type: 'convert', format: 'png' }]), ['image/jpeg'])).toBeDefined();
    expect(localPngHint('private-local', p([{ type: 'convert', format: 'png' }]), ['image/png'])).toBeUndefined();
  });

  it('质量滑块：全 PNG 输出禁用并说明，混合时可用但注明', () => {
    expect(qualityHint(p([{ type: 'compress' }]), ['image/png'])).toEqual({ disabled: true, note: '只对 JPG 和 WebP 有效' });
    expect(qualityHint(p([{ type: 'compress' }, { type: 'convert', format: 'webp' }]), ['image/png']).disabled).toBe(false);
    expect(qualityHint(p([{ type: 'compress' }]), ['image/png', 'image/jpeg'])).toMatchObject({ disabled: false });
    expect(qualityHint(p([{ type: 'compress' }]), ['image/jpeg'])).toEqual({ disabled: false });
  });
});
