import { describe, it, expect } from 'vitest';
import { parseConfig, ConfigError } from '../src/config';
import { buildApp } from '../src/app';
import { AppError } from '../src/errors';

import { sha256Hex } from '../src/auth';
const H = sha256Hex('t');
const base = { auth: { tokens: [{ id: 'qs', sha256: H }] } };

describe('B1 配置', () => {
  it('缺省值来自 LIMITS', () => {
    const c = parseConfig(base);
    expect(c.concurrency).toBe(5);
    expect(c.maxFileBytes).toBe(20 * 1024 * 1024);
  });
  it('字段错误时报出具体路径', () => {
    expect(() => parseConfig({ ...base, port: 'x' })).toThrow(/port/);
    expect(() => parseConfig({ auth: { tokens: [{ id: 'a', sha256: 'bad' }] } })).toThrow(/auth\.tokens\.0\.sha256/);
    expect(() => parseConfig({ ...base, unknownKey: 1 })).toThrow(ConfigError);
  });
  it('非 loopback 禁止关闭认证', () => {
    expect(() => parseConfig({ host: '0.0.0.0', auth: { disabled: true } })).toThrow(/loopback/);
    expect(parseConfig({ host: '127.0.0.1', auth: { disabled: true } }).auth.disabled).toBe(true);
  });
  it('没配 token 又没关认证时报错', () => {
    expect(() => parseConfig({})).toThrow(/auth\.tokens 为空/);
  });
});

describe('B1 HTTP', () => {
  const app = buildApp(parseConfig(base));
  app.get('/boom', async () => { throw new AppError('PROVIDER_TIMEOUT', '超时', { retryable: true, providerId: 'official-tinify' }); });
  app.get('/crash', async () => { throw new Error('api_key=abc leaked'); });

  it('/health 正常并带 X-Request-Id', async () => {
    const r = await app.inject('/api/v1/health');
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
    expect(r.headers['x-request-id']).toBeTruthy();
  });
  it('沿用合法的传入 X-Request-Id', async () => {
    const r = await app.inject({ url: '/api/v1/health', headers: { 'x-request-id': 'req-12345678' } });
    expect(r.headers['x-request-id']).toBe('req-12345678');
  });
  it('AppError 输出统一错误体', async () => {
    const r = await app.inject('/boom');
    expect(r.statusCode).toBe(504);
    expect(r.json()).toEqual({ code: 'PROVIDER_TIMEOUT', message: '超时', retryable: true, providerId: 'official-tinify', requestId: r.headers['x-request-id'] });
  });
  it('未知异常不泄漏信息', async () => {
    const r = await app.inject('/crash');
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('api_key');
    expect(r.json().code).toBe('INTERNAL_ERROR');
  });
  it('404 也是统一错误体', async () => {
    const r = await app.inject({ url: '/api/v1/nope', headers: { authorization: 'Bearer t' } });
    expect(r.statusCode).toBe(404);
    expect(Object.keys(r.json()).sort()).toEqual(['code', 'message', 'requestId', 'retryable']);
  });
});
