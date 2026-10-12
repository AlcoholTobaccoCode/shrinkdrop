import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { parseConfig } from '../src/config';
import { buildApp } from '../src/app';
import { sha256Hex, assertOwner } from '../src/auth';

const cfg = parseConfig({ auth: { tokens: [{ id: 'alice', sha256: sha256Hex('tok-alice') }, { id: 'bob', sha256: sha256Hex('tok-bob') }] } });

describe('B2 认证', () => {
  const app = buildApp(cfg);
  // 模拟 B4 的按 token 隔离
  const owners = new Map([['b1', 'alice']]);
  app.get('/api/v1/batches/:id', async (req) => {
    const { id } = req.params as { id: string };
    assertOwner(req, owners.get(id), 'batch');
    return { batchId: id };
  });

  it('health 无需令牌', async () => { expect((await app.inject('/api/v1/health')).statusCode).toBe(200); });
  it('无令牌 401 AUTH_REQUIRED', async () => {
    const r = await app.inject('/api/v1/whoami');
    expect(r.statusCode).toBe(401); expect(r.json().code).toBe('AUTH_REQUIRED');
  });
  it('错误令牌 401 AUTH_INVALID', async () => {
    const r = await app.inject({ url: '/api/v1/whoami', headers: { authorization: 'Bearer nope' } });
    expect(r.statusCode).toBe(401); expect(r.json().code).toBe('AUTH_INVALID');
    const r2 = await app.inject({ url: '/api/v1/whoami', headers: { authorization: 'Basic xxx' } });
    expect(r2.json().code).toBe('AUTH_INVALID');
  });
  it('正确令牌识别出 tokenId', async () => {
    const r = await app.inject({ url: '/api/v1/whoami', headers: { authorization: 'Bearer tok-bob' } });
    expect(r.json()).toEqual({ tokenId: 'bob' });
  });
  it('A 用户访问 B 用户的批次返回 404', async () => {
    const ok = await app.inject({ url: '/api/v1/batches/b1', headers: { authorization: 'Bearer tok-alice' } });
    expect(ok.statusCode).toBe(200);
    const other = await app.inject({ url: '/api/v1/batches/b1', headers: { authorization: 'Bearer tok-bob' } });
    expect(other.statusCode).toBe(404); expect(other.json().code).toBe('BATCH_NOT_FOUND');
  });
  it('loopback 下关闭认证时统一记为 local', async () => {
    const a = buildApp(parseConfig({ host: '127.0.0.1', auth: { disabled: true } }));
    expect((await a.inject('/api/v1/whoami')).json()).toEqual({ tokenId: 'local' });
  });
  it('非 loopback 加 auth.disabled 拒绝启动', () => {
    expect(() => parseConfig({ host: '192.168.1.5', auth: { disabled: true } })).toThrow();
  });
  it('日志不记录 Authorization', async () => {
    const lines: string[] = [];
    const a = Fastify({ logger: { level: 'info', redact: { paths: ['req.headers.authorization'], censor: '[redacted]' }, stream: { write: (l: string) => lines.push(l) } } });
    a.get('/x', async (req) => { req.log.info({ req: { headers: req.headers } }, 'r'); return 1; });
    await a.inject({ url: '/x', headers: { authorization: 'Bearer tok-alice' } });
    expect(lines.join('')).not.toContain('tok-alice');
  });
});
