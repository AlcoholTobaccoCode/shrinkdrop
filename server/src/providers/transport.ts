import { request } from 'node:https';

export interface ProviderRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: Uint8Array;
  signal: AbortSignal;
}
export interface ProviderResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
}
export type ProviderTransport = (request: ProviderRequest) => Promise<ProviderResponse>;

/** HTTPS 原始传输不跟随重定向；凭据和 URL 范围由 Provider 在每次请求前检查。 */
export const httpsTransport: ProviderTransport = input => new Promise((resolve, reject) => {
  const req = request(input.url, { method: input.method, headers: input.headers, signal: input.signal }, response => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) { response.destroy(new Error('provider response too large')); return; }
      chunks.push(chunk);
    });
    response.on('error', reject);
    response.on('end', () => resolve({
      status: response.statusCode ?? 502,
      headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value])),
      body: Buffer.concat(chunks),
    }));
  });
  req.on('error', reject);
  req.end(input.body);
});

export function header(response: ProviderResponse, name: string): string | undefined {
  const key = Object.keys(response.headers).find(key => key.toLowerCase() === name.toLowerCase());
  return key ? response.headers[key] : undefined;
}
