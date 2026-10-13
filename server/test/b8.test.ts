import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { AccountPool } from '../src/accounts';
import { createProviderService } from '../src/providers/service';
import { accounts, config, fixture, image, signal, validateOrImage } from './provider-fixtures';

describe('B8 官方额度与并发预留', () => {
  it('同一 key 不能以不同用户名重复入池绕过并发额度锁，错误不回显 key', () => {
    const duplicate = 'fixture-duplicate-key-only';
    let error: unknown;
    try { AccountPool.fromJson([{ username: 'first@example.test', api_key: duplicate }, { username: 'second@example.test', api_key: duplicate }]); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain(duplicate);
  });

  it('validate 空 POST 400 获得真实计数；10 并发最多给仅剩 3 次账号分配 3 次', async () => {
    const png = await image(); let count = 497; let uploads = 0;
    const f = await fixture(async (req, res, body) => {
      if (!body.length && req.url === '/shrink') return validateOrImage(req, res, body, png, count);
      if (req.url === '/shrink') { uploads++; await new Promise(resolve => setTimeout(resolve, 10)); res.writeHead(201, { 'Compression-Count': String(++count), Location: 'https://api.tinify.com/output/fixture' }); res.end('{}'); }
      else { res.writeHead(200, { 'Compression-Count': String(count), 'Content-Type': 'image/png' }); res.end(png); }
    });
    const service = createProviderService(config, { accounts: accounts(), transport: f.transport, refreshOnStart: false });
    try {
      expect((await service.refreshUsage('official-tinify')).accounts[0]).toMatchObject({ usedThisMonth: 497, remaining: 3, source: 'compression-count' });
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => service.execute({ providerId: 'official-tinify', operations: [{ type: 'compress' }], data: png, mimeType: 'image/png', signal: signal() })));
      expect(uploads).toBe(3); expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3);
      expect(service.usage('official-tinify').accounts[0]).toMatchObject({ remaining: 0, status: 'exhausted' });
    } finally { service.close(); await f.close(); }
  });

  it('计数缺失立即 unknown，不把缓存计数冒充新额度', async () => {
    const png = await image(); let validated = false;
    const f = await fixture((req, res, body) => {
      if (!validated) { validated = true; return validateOrImage(req, res, body, png, 12); }
      res.writeHead(400); res.end('{}');
    });
    let now = Date.UTC(2026, 9, 13);
    const service = createProviderService(config, { accounts: accounts(), transport: f.transport, now: () => now, refreshOnStart: false });
    try {
      await service.refreshUsage('official-tinify'); now += 60_000;
      const usage = (await service.refreshUsage('official-tinify')).accounts[0]!;
      expect(usage.source).toBe('unknown'); expect(usage.usedThisMonth).toBeUndefined(); expect(usage.remaining).toBeUndefined();
      expect(usage.observedAt).toBe(new Date(now).toISOString());
    } finally { service.close(); await f.close(); }
  });

  it('validate 的 429 不等于还有余额，401 不泄漏上游错误中的 key', async () => {
    const png = await image();
    const f = await fixture((_req, res) => { res.writeHead(429, { 'Compression-Count': '500' }); res.end('{}'); });
    const service = createProviderService(config, { accounts: accounts(), transport: f.transport, refreshOnStart: false });
    try {
      expect((await service.refreshUsage('official-tinify')).accounts[0]).toMatchObject({ remaining: 0, status: 'exhausted' });
      await expect(service.execute({ providerId: 'official-tinify', operations: [{ type: 'compress' }], data: png, mimeType: 'image/png', signal: signal() })).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' });
      expect(f.seen).toHaveLength(1);
    } finally { service.close(); await f.close(); }
  });

  it('手动刷新每账号每分钟最多一次，自动30分钟刷新，跨UTC月份清空旧计数', async () => {
    vi.useFakeTimers();
    let now = Date.UTC(2026, 9, 31, 23, 59); let calls = 0;
    const service = createProviderService(config, { accounts: accounts(), now: () => now, transport: async () => { calls++; return { status: 400, headers: { 'compression-count': '10' }, body: new Uint8Array() }; } });
    try {
      await service.ready(); expect(calls).toBe(1);
      await service.refreshUsage('official-tinify');
      await expect(service.refreshUsage('official-tinify')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      now += 60_000;
      expect(service.usage('official-tinify').accounts[0]).toMatchObject({ source: 'unknown' });
      expect(service.usage('official-tinify').accounts[0]!.usedThisMonth).toBeUndefined();
      await vi.advanceTimersByTimeAsync(30 * 60_000); expect(calls).toBe(4); // 启动、手动、跨月、30分钟各一次
    } finally { service.close(); vi.useRealTimers(); }
  });

  it('多用户共用同一池，操作额外转换成本也需要预留', async () => {
    const png = await image();
    const f = await fixture((req, res, body) => validateOrImage(req, res, body, png, 499));
    const service = createProviderService(config, { accounts: AccountPool.fromJson([{ username: 'paid@example.test', api_key: 'fixture-key-for-paid-test', monthlyLimit: 500 }]), transport: f.transport, refreshOnStart: false });
    try {
      await service.refreshUsage('official-tinify');
      await expect(service.execute({ providerId: 'official-tinify', operations: [{ type: 'compress' }, { type: 'convert', format: 'webp' }], data: png, mimeType: 'image/png', signal: signal() })).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' });
      expect(f.seen).toHaveLength(1);
    } finally { service.close(); await f.close(); }
  });

  it('上月迟到的高计数不能复活到新月额度', async () => {
    let now = Date.UTC(2026, 9, 31, 23, 59, 59);
    let resolve!: (value: { status: number; headers: Record<string, string>; body: Uint8Array }) => void;
    let calls = 0;
    const service = createProviderService(config, { accounts: accounts(), now: () => now, refreshOnStart: false, transport: async () => {
      calls++;
      if (calls === 1) return new Promise(done => { resolve = done; });
      return new Promise(() => {});
    } });
    try {
      const refreshing = service.refreshUsage('official-tinify');
      await Promise.resolve(); now += 2_000;
      resolve({ status: 400, headers: { 'compression-count': '500' }, body: new Uint8Array() });
      const usage = (await refreshing).accounts[0]!;
      expect(usage.source).toBe('unknown'); expect(usage.remaining).toBeUndefined();
      expect(usage.status).not.toBe('exhausted');
    } finally { service.close(); }
  });

  it('401 账号进入 invalid，下次处理选另一账号；上游含 key 的错误内容不外露', async () => {
    const png = await image();
    const pool = AccountPool.fromJson([{ username: 'first@example.test', api_key: 'fixture-first-key-only' }, { username: 'second@example.test', api_key: 'fixture-second-key-only' }]);
    const f = await fixture((req, res, body) => {
      const auth = Buffer.from(String(req.headers.authorization).slice(6), 'base64').toString();
      if (!body.length && req.url === '/shrink') return validateOrImage(req, res, body, png, 0);
      if (auth.endsWith('fixture-first-key-only')) { res.writeHead(401); res.end('{"message":"fixture-first-key-only invalid"}'); }
      else validateOrImage(req, res, body, png, 0);
    });
    const service = createProviderService(config, { accounts: pool, transport: f.transport, refreshOnStart: false });
    try {
      await service.refreshUsage('official-tinify');
      let error: unknown;
      try { await service.execute({ providerId: 'official-tinify', operations: [{ type: 'compress' }], data: png, mimeType: 'image/png', signal: signal() }); }
      catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' }); expect(String(error)).not.toContain('fixture-first-key-only');
      expect(service.usage('official-tinify').accounts[0]).toMatchObject({ status: 'invalid', source: 'unknown' });
      const out = await service.execute({ providerId: 'official-tinify', operations: [{ type: 'compress' }], data: png, mimeType: 'image/png', signal: signal() });
      expect(out.accountId).toBe(pool.accounts[1]!.accountId);
    } finally { service.close(); await f.close(); }
  });

  it('管线中外部同 key 消耗至 500，下一次收费 convert 下单前必须停止', async () => {
    const png = await image(); let convertRequests = 0;
    const f = await fixture(async (req, res, body) => {
      if (req.url === '/shrink' && !body.length) return validateOrImage(req, res, body, png, 498);
      if (req.url === '/shrink') { res.writeHead(201, { 'Compression-Count': '499', Location: 'https://api.tinify.com/output/fixture' }); res.end('{}'); }
      else if (req.method === 'GET') { res.writeHead(200, { 'Compression-Count': '500', 'Content-Type': 'image/png' }); res.end(png); }
      else { convertRequests++; res.writeHead(200, { 'Compression-Count': '501', 'Content-Type': 'image/webp' }); res.end(await sharp(png).webp().toBuffer()); }
    });
    const service = createProviderService(config, { accounts: accounts(), transport: f.transport, refreshOnStart: false });
    try {
      await service.refreshUsage('official-tinify');
      await expect(service.execute({ providerId: 'official-tinify', operations: [{ type: 'compress' }, { type: 'convert', format: 'webp' }], data: png, mimeType: 'image/png', signal: signal() })).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' });
      expect(convertRequests).toBe(0);
      expect(service.usage('official-tinify').accounts[0]).toMatchObject({ usedThisMonth: 500, remaining: 0, status: 'exhausted' });
    } finally { service.close(); await f.close(); }
  });

  it('恰好剩2次可完成compress加convert，已消费预留不重复从剩余额度扣除', async () => {
    const png = await image(); let count = 498;
    const f = await fixture(async (req, res, body) => {
      if (req.url === '/shrink' && !body.length) return validateOrImage(req, res, body, png, count);
      if (req.url === '/shrink') { res.writeHead(201, { 'Compression-Count': String(++count), Location: 'https://api.tinify.com/output/fixture' }); res.end('{}'); }
      else if (req.method === 'GET') { res.writeHead(200, { 'Compression-Count': String(count), 'Content-Type': 'image/png' }); res.end(png); }
      else { res.writeHead(200, { 'Compression-Count': String(++count), 'Content-Type': 'image/webp' }); res.end(await sharp(png).webp().toBuffer()); }
    });
    const service = createProviderService(config, { accounts: accounts(), transport: f.transport, refreshOnStart: false });
    try {
      await service.refreshUsage('official-tinify');
      const out = await service.execute({ providerId: 'official-tinify', operations: [{ type: 'compress' }, { type: 'convert', format: 'webp' }], data: png, mimeType: 'image/png', signal: signal() });
      expect(out.mimeType).toBe('image/webp'); expect(count).toBe(500);
      expect(service.usage('official-tinify').accounts[0]).toMatchObject({ remaining: 0, status: 'exhausted' });
    } finally { service.close(); await f.close(); }
  });
});
