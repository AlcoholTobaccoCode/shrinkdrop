/**
 * 把鼠标滚轮的纵向位移换算成横向滚动目标位置。
 * 返回 null 表示已经到头、无需拦截默认滚动。
 */
export function horizontalWheelTarget(
  metrics: { scrollLeft: number; clientWidth: number; scrollWidth: number },
  delta: number
): number | null {
  if (metrics.scrollWidth <= metrics.clientWidth) return null;
  const max = metrics.scrollWidth - metrics.clientWidth;
  const next = Math.min(max, Math.max(0, metrics.scrollLeft + delta));
  return next === metrics.scrollLeft ? null : next;
}

/** 从滚轮事件取出用于横向滚动的主轴位移。 */
export function wheelDelta(event: { deltaX: number; deltaY: number }): number {
  return Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
}
