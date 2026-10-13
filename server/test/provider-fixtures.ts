import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { AccountPool } from '../src/accounts';
import { parseConfig } from '../src/config';
import type { ProviderTransport, ProviderRequest } from '../src/providers/transport';

export const config = parseConfig({ auth: { disabled: true }, anonymousTinify: { enabled: true } });
export const accounts = () => AccountPool.fromJson([{ username: 'fixture@example.test', api_key: 'fixture-key-no-live-requests', monthlyLimit: 500 }]);
export const image = () => sharp({ create: { width: 8, height: 4, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
export const signal = () => new AbortController().signal;

/** 请求只到临时本机 fixture；逻辑 URL 单独记录，断言真实 Provider 的主机与认证边界。 */
export async function fixture(handler: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void | Promise<void>) {
  const seen: ProviderRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    try { await handler(request, response, Buffer.concat(chunks)); }
    catch { response.writeHead(500); response.end('fixture failed'); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  const transport: ProviderTransport = req => {
    seen.push(req);
    return new Promise((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port, path: new URL(req.url).pathname, method: req.method, headers: req.headers, signal: req.signal }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve({ status: res.statusCode!, headers: Object.fromEntries(Object.entries(res.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value ?? ''])), body: Buffer.concat(chunks) }));
      });
      r.on('error', reject);
      r.end(req.body);
    });
  };
  return { transport, seen, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

export function validateOrImage(request: IncomingMessage, response: ServerResponse, body: Buffer, png: Buffer, count = 1) {
  if (request.url === '/shrink' && body.length === 0) {
    response.writeHead(400, { 'Compression-Count': String(count) }); response.end('{"error":"InputMissing"}');
  } else if (request.url === '/shrink') {
    response.writeHead(201, { 'Compression-Count': String(count + 1), Location: 'https://api.tinify.com/output/fixture' }); response.end('{}');
  } else {
    response.writeHead(200, { 'Compression-Count': String(count + 1), 'Content-Type': 'image/png' }); response.end(png);
  }
}
