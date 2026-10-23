import { describe, expect, it } from 'vitest';
import { horizontalWheelTarget, wheelDelta } from '../../src/core/ui/horizontal-wheel';

describe('horizontal wheel scrolling', () => {
  const row = { scrollLeft: 100, clientWidth: 200, scrollWidth: 500 };

  it('moves horizontally by the wheel delta', () => {
    expect(horizontalWheelTarget(row, 50)).toBe(150);
  });

  it('clamps to the scrollable range', () => {
    expect(horizontalWheelTarget(row, 1000)).toBe(300);
    expect(horizontalWheelTarget({ ...row, scrollLeft: 10 }, -80)).toBe(0);
  });

  it('returns null when there is nothing to scroll', () => {
    expect(horizontalWheelTarget({ scrollLeft: 0, clientWidth: 200, scrollWidth: 200 }, 50)).toBeNull();
    expect(horizontalWheelTarget({ ...row, scrollLeft: 300 }, 50)).toBeNull();
    expect(horizontalWheelTarget({ ...row, scrollLeft: 0 }, -50)).toBeNull();
  });

  it('prefers the larger axis so trackpad horizontal gestures also work', () => {
    expect(wheelDelta({ deltaX: 10, deltaY: 90 })).toBe(90);
    expect(wheelDelta({ deltaX: 90, deltaY: 10 })).toBe(90);
  });
});
