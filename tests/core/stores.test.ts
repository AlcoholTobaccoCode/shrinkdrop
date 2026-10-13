import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { AccountUsage, ImageProviderManifest } from '@tinypng/shared';
import { configureSettingsStorage, SETTINGS_KEY, useSettingsStore } from '../../src/stores/settings';
import { KeychainTokenStorage, SessionTokenStorage, TOKEN_KEY } from '../../src/core/settings/token-storage';
import { useProviderStore } from '../../src/stores/provider';
import { toUsageView, useUsageStore } from '../../src/stores/usage';
import { ApiClient } from '../../src/core/cloud/api-client';

class MapStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
}

const anonymous: ImageProviderManifest = {
  id: 'anonymous-tinify', label: '匿名 Tinify', processing: 'cloud',
  capabilities: { compress: true, convert: [], resize: false, smartResize: false, crop: false, smartCrop: false, metadata: [], urlInput: true, storageOutput: false }
};

describe('settingsStore（D2）', () => {
  let local: MapStorage;
  let session: MapStorage;
  beforeEach(() => {
    local = new MapStorage();
    session = new MapStorage();
    configureSettingsStorage({ kv: local, token: new SessionTokenStorage(session) });
    setActivePinia(createPinia());
  });

  it('A切到B且没有新token时不把A Bearer发给B，同origin更新可保留', async () => {
    const store = useSettingsStore();
    expect(store.setConnection).toBeTypeOf('function');
    if (!store.setConnection) return;
    await store.setConnection('https://a.example/', 'A-secret');
    await store.setConnection('https://a.example:443/proxy', '');
    expect(await store.getToken('https://a.example')).toBe('A-secret');
    await store.setConnection('https://b.example', '');
    const seen: Array<string | undefined> = [];
    const api = new ApiClient({ baseUrl: store.serverUrl, getToken: () => store.getToken('https://b.example'), fetch: async (_url, init) => { seen.push((init?.headers as Record<string, string>).Authorization); return new Response('[]'); } });
    await api.providers();
    expect(seen).toEqual([undefined]);
    expect(store.hasToken).toBe(false);
    expect(session.getItem(TOKEN_KEY)).toBeNull();
    expect(await store.getToken('https://a.example')).toBeUndefined();
  });

  it('换origin并保存新token时，旧ApiClient也不能拿到B token发给A', async () => {
    const store = useSettingsStore();
    expect(store.setConnection).toBeTypeOf('function');
    if (!store.setConnection) return;
    await store.setConnection('https://a.example', 'A-secret');
    await store.setConnection('https://b.example', 'B-secret');
    expect(await store.getToken('https://a.example')).toBeUndefined();
    expect(await store.getToken('https://b.example')).toBe('B-secret');
  });

  it('异步清理旧凭据期间请求等待，完成后A客户端无Bearer、B客户端只得B凭据', async () => {
    const store = useSettingsStore();
    await store.setConnection('https://a.example', 'A-secret');
    let current: string | undefined = 'A-secret';
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    configureSettingsStorage({ token: { kind: 'memory', get: async () => current, set: async value => { current = value; }, clear: async () => { await gate; current = undefined; } } });
    const save = store.setConnection('https://b.example', 'B-secret');
    const seen: Array<{ url: string; auth?: string }> = [];
    const client = (baseUrl: string) => new ApiClient({ baseUrl, getToken: () => store.getToken(baseUrl), fetch: async (url, init) => { seen.push({ url, auth: (init?.headers as Record<string, string>).Authorization }); return new Response('[]'); } });
    const requests = Promise.all([client('https://a.example').providers(), client('https://b.example').providers()]);
    await Promise.resolve();
    expect(seen).toEqual([]);
    release();
    await save;
    await requests;
    expect(seen.find(request => request.url.startsWith('https://a.example'))?.auth).toBeUndefined();
    expect(seen.find(request => request.url.startsWith('https://b.example'))?.auth).toBe('Bearer B-secret');
  });

  it('Web：令牌只进 sessionStorage，localStorage 里没有 token', async () => {
    const store = useSettingsStore();
    store.setServerUrl('https://img.example.com/');
    await store.setToken('secret-token-123');
    store.setMode('cloud');
    expect(session.getItem(TOKEN_KEY)).toBe('secret-token-123');
    const persisted = [...local.map.values()].join('\n');
    expect(persisted).not.toContain('secret-token-123');
    expect(persisted.toLowerCase()).not.toContain('token');
    expect(JSON.parse(local.getItem(SETTINGS_KEY)!).serverUrl).toBe('https://img.example.com');
    expect(store.hasToken).toBe(true);
    await store.clearToken();
    expect(session.getItem(TOKEN_KEY)).toBeNull();
  });

  it('旧数据里混进的 token 字段会被丢弃', () => {
    local.setItem(SETTINGS_KEY, JSON.stringify({ serverUrl: 'x', token: 'leak' }));
    setActivePinia(createPinia());
    const store = useSettingsStore();
    store.persist();
    expect(local.getItem(SETTINGS_KEY)).not.toContain('leak');
  });

  it('Tauri：令牌走钥匙串命令', async () => {
    const calls: Array<[string, unknown]> = [];
    let saved: string | null = null;
    const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push([cmd, args]);
      if (cmd === 'token_set') saved = String(args?.token);
      if (cmd === 'token_clear') saved = null;
      return (cmd === 'token_get' ? saved : undefined) as T;
    };
    configureSettingsStorage({ token: new KeychainTokenStorage(invoke) });
    setActivePinia(createPinia());
    const store = useSettingsStore();
    await store.setToken('k');
    expect(await store.loadToken()).toBe('k');
    expect(store.tokenStorageKind).toBe('keychain');
    expect(calls.map(c => c[0])).toEqual(['token_set', 'token_get']);
    expect([...local.map.values()].join()).not.toContain('"k"');
  });
});

describe('providerStore（D2）', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('内置本地 manifest，云端从 fetcher 加载', async () => {
    const store = useProviderStore();
    await store.refresh(async () => [anonymous]);
    expect(store.all.map(m => m.id)).toEqual(['local', 'anonymous-tinify']);
    expect(store.selectedCloudId).toBe('anonymous-tinify');
  });

  it('匿名线路选了缩放 → 冲突并建议官方，不自动切换', async () => {
    const store = useProviderStore();
    await store.refresh(async () => [anonymous]);
    const conflicts = store.conflicts({ providerId: 'anonymous-tinify', operations: [{ type: 'compress' }, { type: 'resize', width: 100, fit: 'inside' }], destinations: [{ type: 'download' }] });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.index).toBe(1);
    expect(conflicts[0]?.suggestProviderId).toBe('official-tinify');
  });

  it('本地不支持 AVIF 转换', () => {
    const store = useProviderStore();
    expect(store.conflicts({ providerId: 'local', operations: [{ type: 'convert', format: 'avif' }], destinations: [] })).toHaveLength(1);
    expect(store.conflicts({ providerId: 'local', operations: [{ type: 'convert', format: 'webp' }, { type: 'resize', width: 10, fit: 'cover' }], destinations: [] })).toHaveLength(0);
  });
});

describe('usageStore（D2）', () => {
  const base: AccountUsage = { providerId: 'official-tinify', accountId: 'a1', label: 'ab***@x.com', status: 'active', source: 'compression-count', usedThisMonth: 120, limitThisMonth: 500, observedAt: '2026-10-12T09:00:00Z' };

  it('已知额度：显示已用和剩余', () => {
    expect(toUsageView(base)).toMatchObject({ used: 120, remaining: 380, limit: 500 });
  });

  it('来源 unknown：不显示数字', () => {
    const view = toUsageView({ ...base, source: 'unknown' });
    expect(view.used).toBeUndefined();
    expect(view.remaining).toBeUndefined();
  });

  it('无 Compression-Count 时有预算和剩余也不显示数字', () => {
    const view = toUsageView({ ...base, usedThisMonth: undefined, remaining: 500 });
    expect(view.used).toBeUndefined();
    expect(view.remaining).toBeUndefined();
    expect(view.limit).toBeUndefined();
  });

  it.each([NaN, -1, null])('无效计数 %s 按未知处理，不能显示NaN或误导预算', count => {
    const view = toUsageView({ ...base, usedThisMonth: count as number, remaining: 500 });
    expect(view.used).toBeUndefined();
    expect(view.remaining).toBeUndefined();
  });

  it('读取失败时移除旧额度，避免把历史数字伪装成当前用量', async () => {
    setActivePinia(createPinia());
    const store = useUsageStore();
    await store.refresh('official-tinify', async () => ({ providerId: 'official-tinify', accounts: [base] }));
    await store.refresh('official-tinify', async () => { throw new Error('offline'); });
    expect(store.views('official-tinify')).toEqual([]);
    expect(store.error).toBe('offline');
  });

  it('refresh 按 provider 存，本地不请求', async () => {
    setActivePinia(createPinia());
    const store = useUsageStore();
    let calls = 0;
    await store.refresh('local', async () => { calls += 1; return { providerId: 'local', accounts: [] }; });
    await store.refresh('official-tinify', async () => ({ providerId: 'official-tinify', accounts: [base] }));
    expect(calls).toBe(0);
    expect(store.views('official-tinify')[0]?.remaining).toBe(380);
  });
});
