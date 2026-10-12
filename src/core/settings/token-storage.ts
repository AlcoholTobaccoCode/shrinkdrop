/**
 * 访问令牌存储。约束（D2 验收）：令牌绝不写入 localStorage。
 * - Tauri：系统钥匙串（Rust 侧 keyring 命令）
 * - Web：sessionStorage（关闭标签页即失效）
 */
export interface TokenStorage {
  readonly kind: 'keychain' | 'session' | 'memory';
  get(): Promise<string | undefined>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

export const TOKEN_KEY = 'tinypng.accessToken';

export class SessionTokenStorage implements TokenStorage {
  readonly kind = 'session' as const;
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = sessionStorage) {}
  async get(): Promise<string | undefined> {
    return this.storage.getItem(TOKEN_KEY) ?? undefined;
  }
  async set(token: string): Promise<void> {
    this.storage.setItem(TOKEN_KEY, token);
  }
  async clear(): Promise<void> {
    this.storage.removeItem(TOKEN_KEY);
  }
}

export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export class KeychainTokenStorage implements TokenStorage {
  readonly kind = 'keychain' as const;
  constructor(private readonly invoke: Invoke) {}
  async get(): Promise<string | undefined> {
    return (await this.invoke<string | null>('token_get')) ?? undefined;
  }
  async set(token: string): Promise<void> {
    await this.invoke('token_set', { token });
  }
  async clear(): Promise<void> {
    await this.invoke('token_clear');
  }
}

/** 测试 / SSR 兜底 */
export class MemoryTokenStorage implements TokenStorage {
  readonly kind = 'memory' as const;
  private value?: string;
  async get(): Promise<string | undefined> { return this.value; }
  async set(token: string): Promise<void> { this.value = token; }
  async clear(): Promise<void> { this.value = undefined; }
}

export async function createTokenStorage(isTauri: boolean): Promise<TokenStorage> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    return new KeychainTokenStorage(invoke as Invoke);
  }
  if (typeof sessionStorage !== 'undefined') return new SessionTokenStorage();
  return new MemoryTokenStorage();
}
