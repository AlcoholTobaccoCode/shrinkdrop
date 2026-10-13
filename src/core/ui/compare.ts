/** 对比滑块键盘（interaction-specs 1.3）：位置值 = 原图可见比例 0–100 */
export function compareKey(value: number, key: string, shift = false): number | undefined {
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  switch (key) {
    case 'ArrowLeft': return clamp(value - (shift ? 1 : 5));
    case 'ArrowRight': return clamp(value + (shift ? 1 : 5));
    case 'PageDown': return clamp(value - 25);
    case 'PageUp': return clamp(value + 25);
    case 'Home': return 0;
    case 'End': return 100;
    case 'Enter': return 50;
    default: return undefined;
  }
}

export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8] as const;

export function nextZoom(current: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find(z => z > current + 1e-6) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
  return [...ZOOM_STEPS].reverse().find(z => z < current - 1e-6) ?? ZOOM_STEPS[0];
}

/** 以光标点 (px,py)（相对视口）为中心缩放时的新平移 */
export function zoomAt(pan: { x: number; y: number }, from: number, to: number, px: number, py: number): { x: number; y: number } {
  const k = to / from;
  return { x: px - (px - pan.x) * k, y: py - (py - pan.y) * k };
}

export function formatBytes(value: number | undefined): string {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return (value / 1024 ** index).toFixed(index === 0 ? 0 : 1) + ' ' + units[index];
}
