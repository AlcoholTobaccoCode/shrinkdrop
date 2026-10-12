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
  onReconnected: () => Promise<void>;
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
      try {
        this.arm(controller);
        const res = await this.options.open(controller.signal);
        if (!res.body) throw new Error('SSE 无响应体');
        const reconnect = this.everConnected;
        this.everConnected = true;
        attempt = 0;
        if (reconnect) await this.options.onReconnected();
        this.setState('connected');
        this.arm(controller);
        const reader = res.body.getReader();
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
      }
      if (this.stopped) break;
      this.setState('interrupted');
      const wait = this.options.backoffMs?.(attempt) ?? Math.min(15_000, 1000 * 2 ** attempt);
      attempt += 1;
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

function readWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => { void reader.cancel().catch(() => undefined); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      r => { signal.removeEventListener('abort', onAbort); resolve(r); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); }
    );
  });
}
