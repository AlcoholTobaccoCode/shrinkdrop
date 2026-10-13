import { SSE_HEARTBEAT_INTERVAL_MS, type BatchEvent } from '@tinypng/shared';

/** 30 秒（2 × 心跳）收不到任何事件判定中断 */
export const SSE_IDLE_TIMEOUT_MS = SSE_HEARTBEAT_INTERVAL_MS * 2;

/** 解析 text/event-stream：按空行分帧，拼接多行 data，忽略注释行 */
export class SseParser {
  private buffer = '';
  push(chunk: string): Array<{ event?: string; data: string; id?: string }> {
    this.buffer += chunk.replace(/\r\n?/g, '\n');
    const out: Array<{ event?: string; data: string; id?: string }> = [];
    let index: number;
    while ((index = this.buffer.indexOf('\n\n')) >= 0) {
      const frame = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      let event: string | undefined; let id: string | undefined; const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
        else if (field === 'id') id = value;
      }
      if (data.length) out.push({ event, data: data.join('\n'), id });
    }
    return out;
  }
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'interrupted';

export interface SseClientOptions {
  open: (signal: AbortSignal) => Promise<Response>;
  onEvent: (event: BatchEvent) => void;
  onState: (state: ConnectionState) => void;
  /** 重连成功后调用（全量 GET /batches/:id 校正） */
  onReconnected: (signal: AbortSignal) => Promise<void>;
  idleTimeoutMs?: number;
  /** 重连退避，默认 1s、2s、4s… 封顶 15s */
  backoffMs?: (attempt: number) => number;
}

/**
 * fetch + ReadableStream 读 SSE（能带 Bearer）。
 * 任何字节（含心跳）都会重置看门狗；超时或断流 → interrupted → 退避重连 → 成功后先全量重拉。
 */
export class SseClient {
  state: ConnectionState = 'idle';
  private controller?: AbortController;
  private stopped = true;
  private timer?: ReturnType<typeof setTimeout>;
  private everConnected = false;
  private loop?: Promise<void>;

  constructor(private readonly options: SseClientOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    this.controller?.abort();
    this.setState('idle');
    await this.loop?.catch(() => undefined);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onState(state);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(controller: AbortController): void {
    this.clearTimer();
    this.timer = setTimeout(() => controller.abort(new Error('SSE 超时')), this.options.idleTimeoutMs ?? SSE_IDLE_TIMEOUT_MS);
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      const controller = new AbortController();
      this.controller = controller;
      if (!this.everConnected) this.setState('connecting');
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        this.arm(controller);
        const opening = this.options.open(controller.signal);
        // 底层忽略 AbortSignal 时，关闭仍立即返回；迟到响应单独释放。
        void opening.then(res => {
          if (controller.signal.aborted) void res.body?.cancel().catch(() => undefined);
        }, () => undefined);
        response = await withAbort(opening, controller.signal);
        if (!response.body) throw new Error('SSE 无响应体');
        if (controller.signal.aborted) throw controller.signal.reason;
        const reconnect = this.everConnected;
        this.everConnected = true;
        attempt = 0;
        if (reconnect) await withAbort(this.options.onReconnected(controller.signal), controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
        this.setState('connected');
        this.arm(controller);
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        for (;;) {
          const { value, done } = await readWithAbort(reader, controller.signal);
          if (done) break;
          this.arm(controller);
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            try {
              this.options.onEvent(JSON.parse(frame.data) as BatchEvent);
            } catch {
              // 坏帧忽略
            }
          }
        }
      } catch {
        // 进入重连
      } finally {
        this.clearTimer();
        // 取消流本身也可能挂起，不能把它纳入 stop() 的等待链。
        if (reader) {
          void reader.cancel().catch(() => undefined);
          reader.releaseLock();
        } else {
          void response?.body?.cancel().catch(() => undefined);
        }
      }
      if (this.stopped) break;
      this.setState('interrupted');
      if (this.stopped) break;
      const wait = this.options.backoffMs?.(attempt) ?? Math.min(15_000, 1000 * 2 ** attempt);
      attempt += 1;
      const backoffController = new AbortController();
      this.controller = backoffController;
      await waitWithAbort(wait, backoffController.signal).catch(() => undefined);
    }
  }
}

function readWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return withAbort(reader.read(), signal);
}

/** 所有异步边界都能被关闭和看门狗打断，底层 Promise 迟到时仍有 rejection handler。 */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      r => { signal.removeEventListener('abort', onAbort); resolve(r); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); }
    );
  });
}

/** 退避结束或取消时同时释放计时器与监听，关闭不必等下一次重连。 */
function waitWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', onAbort); resolve(); };
    const timer = setTimeout(finish, ms);
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
