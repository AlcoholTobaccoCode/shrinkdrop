import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../src/core/cloud/api-client';
import { SseClient } from '../../src/core/cloud/sse';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

afterEach(() => { vi.useRealTimers(); });

describe('SSE 关闭与恢复请求取消', () => {
  it('恢复 GET 忽略取消时，stop 仍立即结束并取消尚未读取的流', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const cancelled = vi.fn();
    let opens = 0;
    let recoverySignal: AbortSignal | undefined;
    const client = new SseClient({
      open: async () => new Response(new ReadableStream<Uint8Array>({
        start: controller => { if (++opens === 1) controller.close(); },
        cancel: cancelled
      })),
      onEvent: () => undefined,
      onState: () => undefined,
      onReconnected: async signal => { recoverySignal = signal; await gate.promise; },
      idleTimeoutMs: 500,
      backoffMs: () => 5
    });
    client.start();
    await vi.advanceTimersByTimeAsync(5);
    expect(opens).toBe(2);
    let stopped = false;
    const stop = client.stop().then(() => { stopped = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(true);
      expect(recoverySignal?.aborted).toBe(true);
      expect(cancelled).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve();
      await vi.advanceTimersByTimeAsync(1000);
      await stop;
    }
  });

  it('看门狗能跳出忽略取消的恢复 GET 并重新连接', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    let opens = 0;
    const recoverySignals: AbortSignal[] = [];
    const client = new SseClient({
      open: async () => new Response(new ReadableStream<Uint8Array>({ start: controller => { if (++opens === 1) controller.close(); } })),
      onEvent: () => undefined,
      onState: () => undefined,
      onReconnected: async signal => { recoverySignals.push(signal); if (recoverySignals.length === 1) await gate.promise; },
      idleTimeoutMs: 20,
      backoffMs: () => 5
    });
    client.start();
    try {
      await vi.advanceTimersByTimeAsync(30);
      expect(opens).toBe(3);
      expect(recoverySignals[0]?.aborted).toBe(true);
      expect(recoverySignals).toHaveLength(2);
    } finally {
      gate.resolve();
      const stop = client.stop();
      await vi.advanceTimersByTimeAsync(1000);
      await stop;
    }
  });

  it('stop 不等待忽略取消的 open，迟到响应会释放流', async () => {
    vi.useFakeTimers();
    const gate = deferred<Response>();
    const cancelled = vi.fn();
    const client = new SseClient({ open: () => gate.promise, onEvent: () => undefined, onState: () => undefined, onReconnected: async () => undefined });
    client.start();
    let stopped = false;
    const stop = client.stop().then(() => { stopped = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(true);
    } finally {
      gate.resolve(new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })));
      await vi.advanceTimersByTimeAsync(0);
      await stop;
    }
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('stop 立即退出长退避，并且不会再发起连接', async () => {
    vi.useFakeTimers();
    const open = vi.fn(async () => { throw new Error('offline'); });
    const client = new SseClient({ open, onEvent: () => undefined, onState: () => undefined, onReconnected: async () => undefined, backoffMs: () => 1000 });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stop = client.stop().then(() => { stopped = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(true);
    } finally {
      await vi.advanceTimersByTimeAsync(1000);
      await stop;
    }
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('流的 cancel 忽略取消时，stop 不等待清理 Promise 且释放 reader 锁', async () => {
    vi.useFakeTimers();
    const cancelGate = deferred<void>();
    const cancelled = vi.fn(() => cancelGate.promise);
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }));
    const client = new SseClient({ open: async () => response, onEvent: () => undefined, onState: () => undefined, onReconnected: async () => undefined });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(response.body?.locked).toBe(true);
    let stopped = false;
    const stop = client.stop().then(() => { stopped = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(true);
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(response.body?.locked).toBe(false);
    } finally {
      cancelGate.resolve();
      await stop;
    }
  });

  it('GET batch 将校正请求的取消信号传到底层 fetch', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}'));
    const api = new ApiClient({ baseUrl: 'http://fixture.invalid', getToken: async () => undefined, fetch });
    await api.getBatch('b1', controller.signal);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});
