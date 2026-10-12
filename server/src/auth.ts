import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerConfig } from './config';
import { AppError } from './errors';

export const LOCAL_TOKEN_ID = 'local';
const PUBLIC_PATHS = new Set(['/api/v1/health']);

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** 返回匹配的 tokenId；逐个常数时间比较，避免时序泄漏 */
export function matchToken(config: ServerConfig, token: string): string | undefined {
  const h = Buffer.from(sha256Hex(token), 'hex');
  let found: string | undefined;
  for (const t of config.auth.tokens) {
    if (timingSafeEqual(h, Buffer.from(t.sha256, 'hex')) && !found) found = t.id;
  }
  return found;
}

export function registerAuth(app: FastifyInstance, config: ServerConfig): void {
  app.decorateRequest('tokenId', '');
  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/') || PUBLIC_PATHS.has(path)) return;
    if (config.auth.disabled) { req.tokenId = LOCAL_TOKEN_ID; return; }
    const h = req.headers.authorization;
    if (!h) throw new AppError('AUTH_REQUIRED', '缺少访问令牌');
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (!m?.[1]) throw new AppError('AUTH_INVALID', '访问令牌格式错误，应为 Bearer <token>');
    const id = matchToken(config, m[1]);
    if (!id) throw new AppError('AUTH_INVALID', '访问令牌无效');
    req.tokenId = id;
  });
}

/** B4 起使用：资源不属于当前 token 时一律按不存在处理（404），不暴露存在性 */
export function assertOwner(req: FastifyRequest, ownerTokenId: string | undefined, kind: 'batch' | 'job'): void {
  if (ownerTokenId === undefined || ownerTokenId !== req.tokenId) {
    throw kind === 'batch'
      ? new AppError('BATCH_NOT_FOUND', '批次不存在')
      : new AppError('JOB_NOT_FOUND', '任务不存在');
  }
}

declare module 'fastify' {
  interface FastifyRequest { tokenId: string }
}
