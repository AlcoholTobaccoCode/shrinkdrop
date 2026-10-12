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
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;

let tokenStorage: TokenStorage = new MemoryTokenStorage();
let kv: KV | undefined = typeof localStorage !== 'undefined' ? localStorage : undefined;

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
    tokenStorageKind: tokenStorage.kind as TokenStorage['kind']
  }),
  actions: {
    persist(): void {
      const data: PersistedSettings = {
        serverUrl: this.serverUrl,
        mode: this.mode,
        defaultPipeline: this.defaultPipeline,
        lastSaveDir: this.lastSaveDir
      };
      kv?.setItem(SETTINGS_KEY, JSON.stringify(data));
    },
    setServerUrl(url: string): void {
      this.serverUrl = url.trim().replace(/\/+$/, '');
      this.persist();
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
      return token;
    },
    async setToken(token: string): Promise<void> {
      await tokenStorage.set(token.trim());
      this.hasToken = token.trim().length > 0;
    },
    async clearToken(): Promise<void> {
      await tokenStorage.clear();
      this.hasToken = false;
    },
    /** 给 CloudExecutor 取请求头用，不进 state */
    getToken(): Promise<string | undefined> {
      return tokenStorage.get();
    }
  }
});
