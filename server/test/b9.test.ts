import { describe, expect, it } from 'vitest';
import { AccountPool } from '../src/accounts';
import { createProviderService } from '../src/providers/service';
import { accounts, config, fixture, image, signal } from './provider-fixtures';

describe('B9 匿名 Provider', () => {
  it.each([400, 401, 403, 413, 429])('匿名上游 %i 只提示匿名线路不可用，可手动选官方，不要求检查官方 key', async httpStatus => {
    const png = await image();
    const f = await fixture((_req, res) => { res.writeHead(httpStatus); res.end('{"message":"check official api_key secret"}'); });
    const service = createProviderService({ ...config, maxRetries: 0 }, { accounts: AccountPool.fromJson([]), transport: f.transport, refreshOnStart: false });
    try {
      let error: unknown;
      try { await service.execute({ providerId: 'anonymous-tinify', operations: [{ type: 'compress' }], data: png, mimeType: 'image/png', signal: signal() }); }
      catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: httpStatus === 401 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR', message: '匿名线路暂时不可用，请稍后重试或手动选择官方线路', opts: { providerId: 'anonymous-tinify', retryable: httpStatus === 429 } });
      expect(String(error)).not.toMatch(/账号配置|api_key|secret|key/i);
      expect(f.seen).toHaveLength(1);
      expect(f.seen.every(req => new URL(req.url).host !== 'api.tinify.com' && !Object.keys(req.headers).some(key => key.toLowerCase() === 'authorization'))).toBe(true);
    } finally { service.close(); await f.close(); }
  });

  it('匿名 401 不重试鉴权、不自动调用官方账号', async () => {
    const png = await image();
    const f = await fixture((_req, res) => { res.writeHead(401); res.end('{}'); });
    const service = createProviderService(config, { accounts: accounts(), transport: f.transport, refreshOnStart: false });
    try {
      await expect(service.execute({ providerId: 'anonymous-tinify', operations: [{ type: 'compress' }], data: png, mimeType: 'image/png', signal: signal() })).rejects.toMatchObject({ opts: { retryable: false }, message: '匿名线路暂时不可用，请稍后重试或手动选择官方线路' });
      expect(f.seen).toHaveLength(1); expect(new URL(f.seen[0]!.url).host).toBe('tinypng.com');
    } finally { service.close(); await f.close(); }
  });

  it('关闭开关立即拒绝，匿名不支持转换且建议官方，不自动切线路', async () => {
    const png = await image(); let calls = 0;
    const service = createProviderService({ ...config, anonymousTinify: { enabled: false } }, { accounts: accounts(), refreshOnStart: false, transport: async () => { calls++; throw new Error('must not request'); } });
    try {
      await expect(service.execute({ providerId: 'anonymous-tinify', operations: [{ type: 'compress' }], data: png, mimeType: 'image/png', signal: signal() })).rejects.toMatchObject({ code: 'ANONYMOUS_DISABLED' });
      expect(calls).toBe(0);
    } finally { service.close(); }
    const enabled = createProviderService(config, { accounts: accounts(), refreshOnStart: false, transport: async () => { calls++; throw new Error('must not request'); } });
    try {
      await expect(enabled.execute({ providerId: 'anonymous-tinify', operations: [{ type: 'convert', format: 'webp' }], data: png, mimeType: 'image/png', signal: signal() })).rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED', opts: { suggestProviderId: 'official-tinify' } });
      expect(calls).toBe(0);
    } finally { enabled.close(); }
  });

  it('fixture 上最多2重试，轮换网站并审计HTTP状态；无Auth或伪造XFF', async () => {
    const png = await image(); let uploads = 0; const audit: unknown[] = [];
    const f = await fixture((req, res) => {
      if (req.method === 'POST') {
        uploads++;
        if (uploads < 3) { res.writeHead(503); res.end('{}'); }
        else { res.writeHead(201); res.end(JSON.stringify({ output: { url: 'https://tinypng.com/output/fixture' } })); }
      } else { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); }
    });
    const service = createProviderService({ ...config, maxRetries: 5 }, { accounts: accounts(), transport: f.transport, refreshOnStart: false, audit: record => audit.push(record), retryDelayMs: 0 });
    try {
      const out = await service.execute({ providerId: 'anonymous-tinify', operations: [{ type: 'compress' }], data: png, mimeType: 'image/png', signal: signal() });
      expect(out).toMatchObject({ width: 8, height: 4 }); expect(uploads).toBe(3);
      expect(new Set(f.seen.slice(0, 3).map(req => new URL(req.url).host)).size).toBe(3);
      expect(f.seen.every(req => !Object.keys(req.headers).some(key => ['authorization', 'x-forwarded-for'].includes(key.toLowerCase())))).toBe(true);
      expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ providerId: 'anonymous-tinify', attempt: 0, httpStatus: 503 }), expect.objectContaining({ attempt: 2, httpStatus: 201, rotations: 2 })]));
    } finally { service.close(); await f.close(); }
  });

  it('永久失败停止于3次尝试，不调用官方账号', async () => {
    const png = await image();
    const f = await fixture((_req, res) => { res.writeHead(429); res.end('{}'); });
    const service = createProviderService(config, { accounts: accounts(), transport: f.transport, refreshOnStart: false, retryDelayMs: 0 });
    try {
      await expect(service.execute({ providerId: 'anonymous-tinify', operations: [{ type: 'compress' }], data: png, mimeType: 'image/png', signal: signal() })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(f.seen).toHaveLength(3); expect(f.seen.some(req => new URL(req.url).host === 'api.tinify.com')).toBe(false);
    } finally { service.close(); await f.close(); }
  });

  it('传输无响应按单请求超时中断，审计零HTTP状态，不泄漏原始传输错误', async () => {
    const png = await image(); const audit: unknown[] = [];
    const service = createProviderService({ ...config, providerTimeoutMs: 10, maxRetries: 0 }, { accounts: accounts(), refreshOnStart: false, audit: record => audit.push(record), transport: async () => new Promise(() => {}) });
    try {
      await expect(service.execute({ providerId: 'anonymous-tinify', operations: [{ type: 'compress' }], data: png, mimeType: 'image/png', signal: signal() })).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
      expect(audit).toEqual([expect.objectContaining({ providerId: 'anonymous-tinify', httpStatus: 0, attempt: 0, rotations: 0 })]);
    } finally { service.close(); }
  });
});
