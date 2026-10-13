import { defineStore } from 'pinia';
import type { ProcessingPolicy } from '@tinypng/shared';
import { defaultPipeline, type Pipeline } from '../core/workbench/model';
import { MemoryTokenStorage, type TokenStorage } from '../core/settings/token-storage';

/** 只存非敏感设置；令牌永远走 TokenStorage */
export const SETTINGS_KEY = 'tinypng.settings';

interface PersistedSettings {
  serverUrl: string;
  mode: ProcessingPolicy;
  defaultPipeline: Pipeline;
  /** Tauri 上次保存目录 */
  lastSaveDir?: string;
  /** 令牌绑定的 origin，只保存非敏感主机信息。 */
  credentialOrigin?: string;
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;

let tokenStorage: TokenStorage = new MemoryTokenStorage();
let kv: KV | undefined = typeof localStorage !== 'undefined' ? localStorage : undefined;
let connectionTail: Promise<void> = Promise.resolve();

function origin(url: string): string | undefined {
  try { return new URL(url).origin; } catch { return undefined; }
}

/** 启动时注入（main.ts 按平台选择；测试注入假实现） */
export function configureSettingsStorage(options: { token?: TokenStorage; kv?: KV }): void {
  if (options.token) tokenStorage = options.token;
  if (options.kv) kv = options.kv;
}

function load(): PersistedSettings {
  const fallback: PersistedSettings = { serverUrl: '', mode: 'private-local', defaultPipeline: defaultPipeline() };
  try {
    const raw = kv?.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedSettings> & { token?: unknown };
    delete parsed.token;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    ...load(),
    hasToken: false,
    connectionUpdating: false,
    tokenStorageKind: tokenStorage.kind as TokenStorage['kind']
  }),
  actions: {
    persist(): void {
      const data: PersistedSettings = {
        serverUrl: this.serverUrl,
        mode: this.mode,
        defaultPipeline: this.defaultPipeline,
        lastSaveDir: this.lastSaveDir,
        credentialOrigin: this.credentialOrigin
      };
      kv?.setItem(SETTINGS_KEY, JSON.stringify(data));
    },
    setServerUrl(url: string): void {
      this.serverUrl = url.trim().replace(/\/+$/, '');
      this.persist();
    },
    /** 先处理凭据，再发布新地址；取令牌的请求等待这一步完成并核对 origin。 */
    async setConnection(url: string, token?: string): Promise<void> {
      const parsed = new URL(url.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Server 地址只支持 http 或 https');
      const normalized = parsed.href.replace(/\/+$/, '');
      const nextOrigin = parsed.origin;
      const update = connectionTail.then(async () => {
        this.connectionUpdating = true;
        try {
          if (origin(this.serverUrl) !== nextOrigin || this.credentialOrigin !== nextOrigin) {
            await tokenStorage.clear();
            this.hasToken = false;
            this.credentialOrigin = undefined;
          }
          if (token?.trim()) {
            await tokenStorage.set(token.trim());
            this.hasToken = true;
            this.credentialOrigin = nextOrigin;
          }
          this.serverUrl = normalized;
          this.persist();
        } finally { this.connectionUpdating = false; }
      });
      connectionTail = update.catch(() => undefined);
      await update;
    },
    setMode(mode: ProcessingPolicy): void {
      this.mode = mode;
      this.persist();
    },
    setDefaultPipeline(pipeline: Pipeline): void {
      this.defaultPipeline = pipeline;
      this.persist();
    },
    setLastSaveDir(dir: string | undefined): void {
      this.lastSaveDir = dir;
      this.persist();
    },
    async loadToken(): Promise<string | undefined> {
      this.tokenStorageKind = tokenStorage.kind;
      const token = await tokenStorage.get();
      this.hasToken = Boolean(token);
      if (origin(this.serverUrl) && this.credentialOrigin !== origin(this.serverUrl)) this.hasToken = false;
      return token;
    },
    async setToken(token: string): Promise<void> {
      await tokenStorage.set(token.trim());
      this.hasToken = token.trim().length > 0;
      this.credentialOrigin = origin(this.serverUrl);
      this.persist();
    },
    async clearToken(): Promise<void> {
      await tokenStorage.clear();
      this.hasToken = false;
      this.credentialOrigin = undefined;
      this.persist();
    },
    /** 给 CloudExecutor 取请求头用，不进 state */
    async getToken(serverUrl?: string): Promise<string | undefined> {
      await connectionTail;
      if (serverUrl !== undefined && (origin(serverUrl) !== origin(this.serverUrl) || origin(serverUrl) !== this.credentialOrigin)) return undefined;
      const token = await tokenStorage.get();
      if (serverUrl !== undefined && (origin(serverUrl) !== origin(this.serverUrl) || origin(serverUrl) !== this.credentialOrigin)) return undefined;
      return token;
    }
  }
});
