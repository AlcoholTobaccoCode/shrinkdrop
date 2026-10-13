/**
 * 本地私有模式的网络护栏：处理期间把 fetch / XHR / WebSocket / EventSource / sendBeacon 换成会抛错的版本，
 * 并统计被拦下的请求数（界面常驻“网络请求 0”）。Tauri 本机文件 IPC 单独校验，不计为联网。
 * 引用计数，多个批次并行时最后一个结束才恢复。
 */
export class NetworkBlockedError extends Error {
  constructor(what: string) {
    super('本地私有模式禁止网络请求：' + what);
    this.name = 'NetworkBlockedError';
  }
}

type Global = typeof globalThis & Record<string, unknown>;
const KEYS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'] as const;

//#region 本机文件 IPC 能力
const LOCAL_FILE_COMMANDS = new Set([
  '/choose_files', '/choose_directory', '/read_file', '/write_temp', '/save_temp_file', '/cleanup_temp_files'
]);

/** Tauri 的 fetch 传输是本机 IPC；普通 localhost、其他命令或伪装地址仍按网络请求拦截。 */
function isLocalFileIpc(target: Global, input: RequestInfo | URL, init?: RequestInit): boolean {
  const runtime = target.__TAURI_INTERNALS__ as { invoke?: unknown; convertFileSrc?: unknown } | undefined;
  if (typeof runtime?.invoke !== 'function' || typeof runtime.convertFileSrc !== 'function') return false;
  try {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const internalHost = (url.protocol === 'ipc:' && url.hostname === 'localhost')
      || (url.protocol === 'http:' && url.hostname === 'ipc.localhost');
    if (!internalHost || url.username || url.password || url.port || url.search || url.hash || !LOCAL_FILE_COMMANDS.has(url.pathname)) return false;
    if ((init?.method ?? request?.method ?? 'GET').toUpperCase() !== 'POST') return false;
    const headers = new Headers(init?.headers ?? request?.headers);
    const contentType = headers.get('Content-Type');
    const callback = headers.get('Tauri-Callback');
    const error = headers.get('Tauri-Error');
    // 随机 invoke key 的真实匹配和文件 ID 校验由原生端执行；这里保留原生调用特征。
    return Boolean(headers.get('Tauri-Invoke-Key')?.trim())
      && callback !== null && /^\d+$/.test(callback) && Number(callback) <= 0xffffffff
      && error !== null && /^\d+$/.test(error) && Number(error) <= 0xffffffff
      && (contentType === 'application/json' || contentType === 'application/octet-stream');
  } catch {
    return false;
  }
}
//#endregion

export class NetworkGuard {
  /** 被拦下的请求数；正常应为 0 */
  blocked = 0;
  private depth = 0;
  private saved = new Map<string, unknown>();
  private savedBeacon?: unknown;

  constructor(private readonly target: Global = globalThis as Global) {}

  get active(): boolean {
    return this.depth > 0;
  }

  enable(): void {
    if (this.depth++ > 0) return;
    for (const key of KEYS) {
      if (!(key in this.target)) continue;
      this.saved.set(key, this.target[key]);
      const guard = this;
      const original = this.target[key];
      const blocker = key === 'fetch'
        ? (input: RequestInfo | URL, init?: RequestInit) => {
          if (isLocalFileIpc(guard.target, input, init)) return (original as typeof fetch).call(guard.target, input, init);
          guard.blocked += 1;
          return Promise.reject(new NetworkBlockedError(String(input)));
        }
        : function Blocked(): never { guard.blocked += 1; throw new NetworkBlockedError(key); };
      (this.target as Record<string, unknown>)[key] = blocker;
    }
    const nav = this.target.navigator as (Navigator & Record<string, unknown>) | undefined;
    if (nav && typeof nav.sendBeacon === 'function') {
      this.savedBeacon = nav.sendBeacon;
      try {
        Object.defineProperty(nav, 'sendBeacon', { configurable: true, value: () => { this.blocked += 1; return false; } });
      } catch {
        this.savedBeacon = undefined;
      }
    }
  }

  disable(): void {
    if (this.depth === 0 || --this.depth > 0) return;
    for (const [key, value] of this.saved) (this.target as Record<string, unknown>)[key] = value;
    this.saved.clear();
    const nav = this.target.navigator as (Navigator & Record<string, unknown>) | undefined;
    if (nav && this.savedBeacon) {
      Object.defineProperty(nav, 'sendBeacon', { configurable: true, value: this.savedBeacon });
      this.savedBeacon = undefined;
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.enable();
    try {
      return await fn();
    } finally {
      this.disable();
    }
  }
}
