/**
 * 本地私有模式的网络护栏：处理期间把 fetch / XHR / WebSocket / EventSource / sendBeacon 换成会抛错的版本，
 * 并统计被拦下的请求数（界面常驻“网络请求 0”）。引用计数，多个批次并行时最后一个结束才恢复。
 */
export class NetworkBlockedError extends Error {
  constructor(what: string) {
    super('本地私有模式禁止网络请求：' + what);
    this.name = 'NetworkBlockedError';
  }
}

type Global = typeof globalThis & Record<string, unknown>;
const KEYS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'] as const;

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
      const blocker = key === 'fetch'
        ? (input: unknown) => { guard.blocked += 1; return Promise.reject(new NetworkBlockedError(String(input))); }
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
