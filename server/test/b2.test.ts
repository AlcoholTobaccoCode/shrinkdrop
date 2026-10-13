import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { parseConfig } from '../src/config';
import { buildApp } from '../src/app';
import { sha256Hex } from '../src/auth';

const cfg = parseConfig({ auth: { tokens: [{ id: 'alice', sha256: sha256Hex('tok-alice') }, { id: 'bob', sha256: sha256Hex('tok-bob') }] } });

describe('B2 认证', () => {
  const app = buildApp(cfg);

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
    const created = await app.inject({ method: 'POST', url: '/api/v1/batches', headers: { authorization: 'Bearer tok-alice' }, payload: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] } });
    expect(created.statusCode).toBe(201);
    const id = created.json().batchId;
    const ok = await app.inject({ url: `/api/v1/batches/${id}`, headers: { authorization: 'Bearer tok-alice' } });
    expect(ok.statusCode).toBe(200);
    const other = await app.inject({ url: `/api/v1/batches/${id}`, headers: { authorization: 'Bearer tok-bob' } });
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

describe('B2 CORS认证边界',()=>{
  it('允许Web预检，实际请求仍需Bearer；拒绝未知Origin',async()=>{
    const a=buildApp(cfg);
    const good=await a.inject({method:'OPTIONS',url:'/api/v1/batches',headers:{origin:'http://localhost:5170','access-control-request-method':'POST','access-control-request-headers':'authorization,content-type'}});
    expect(good.statusCode).toBe(204);expect(good.headers['access-control-allow-origin']).toBe('http://localhost:5170');
    const bad=await a.inject({method:'OPTIONS',url:'/api/v1/batches',headers:{origin:'https://evil.example','access-control-request-method':'POST'}});
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    const noToken=await a.inject({url:'/api/v1/providers',headers:{origin:'http://localhost:5170'}});expect(noToken.statusCode).toBe(401);
    await a.close();
  });
});

it('本机无令牌模式拒绝DNS rebinding Host/未知Origin，允许CLI及自身origin',async()=>{
 const local=buildApp(parseConfig({auth:{disabled:true}}));const body={providerId:'official-tinify',operations:[{type:'compress'}],destinations:[{type:'download'}]};
 try {
  for(const incoming of [{host:'rebind.attacker.test:8787',origin:'http://rebind.attacker.test:8787'},{host:'127.0.0.1:8787',origin:'https://evil.example'},{host:'127.0.0.1.public.example:8787'},{host:'evil@localhost:8787'}]){
   const r=await local.inject({method:'POST',url:'/api/v1/batches',headers:incoming,payload:body});expect(r.statusCode).toBe(403);expect(r.json()).toMatchObject({code:'AUTH_INVALID',retryable:false});
  }
  for(const incoming of [{host:'127.0.0.1:8787'},{host:'[::1]:8787',origin:'http://[::1]:8787'},{host:'127.0.0.1:8787',origin:'http://127.0.0.1:8787'},{host:'localhost:8787',origin:'http://localhost:5170'}])expect((await local.inject({method:'POST',url:'/api/v1/batches',headers:incoming,payload:body})).statusCode).toBe(201);
 }finally{await local.close();}
 const authenticated=buildApp(cfg);try{expect((await authenticated.inject({method:'POST',url:'/api/v1/batches',headers:{host:'public.example:8787',origin:'https://other.example',authorization:'Bearer tok-alice'},payload:body})).statusCode).toBe(201);}finally{await authenticated.close();}
});
