import { describe, expect, it, vi } from 'vitest';
import { createUUID } from '../../src/core/lite/id';

describe('UUID compatibility', () => {
  it('uses the native UUID capability when available', () => {
    expect(createUUID({ randomUUID: () => '12345678-1234-4234-8234-123456789012', getRandomValues: vi.fn() })).toBe('12345678-1234-4234-8234-123456789012');
  });
  it('creates a version 4 UUID on older WebViews with getRandomValues', () => {
    const id = createUUID({ getRandomValues: array => { array.fill(0); return array; } });
    expect(id).toBe('00000000-0000-4000-8000-000000000000');
  });
});
