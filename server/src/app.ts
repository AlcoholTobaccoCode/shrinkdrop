import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { ApiError } from '@tinypng/shared';
import type { ServerConfig } from './config';
import { AppError } from './errors';
import { registerAuth } from './auth';

const REDACT = /(authorization|api_key|apikey|secret|token)/i;

export function buildApp(config: ServerConfig, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ? { redact: { paths: ['req.headers.authorization'], censor: '[redacted]' } } : false,
    bodyLimit: config.maxFileBytes + 1024 * 1024,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
  });

  app.decorate('config', config);
  app.addHook('onRequest', async (req, reply) => { reply.header('X-Request-Id', req.id); });
  registerAuth(app, config);
  app.get('/api/v1/whoami', async (req) => ({ tokenId: req.tokenId }));

  app.setErrorHandler((rawErr, req, reply) => {
    const err = rawErr as Error & { validation?: unknown; code?: string };
    let e: AppError;
    if (err instanceof AppError) e = err;
    else if (err.validation) e = new AppError('VALIDATION_FAILED', err.message);
    else if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') e = new AppError('FILE_TOO_LARGE', `文件超过 ${config.maxFileBytes} 字节上限`);
    else {
      req.log.error({ err: { message: REDACT.test(err.message) ? '[redacted]' : err.message } }, 'unhandled');
      e = new AppError('INTERNAL_ERROR', '服务器内部错误', { retryable: true });
    }
    reply.status(e.httpStatus).send(e.toBody(req.id));
  });

  app.setNotFoundHandler((req, reply) => {
    const body: ApiError = { code: 'VALIDATION_FAILED', message: `接口不存在：${req.method} ${req.url.split('?')[0]}`, retryable: false, requestId: req.id };
    reply.status(404).send(body);
  });

  app.get('/api/v1/health', async () => ({ ok: true, version: '0.1.0', time: new Date().toISOString() }));

  return app;
}

declare module 'fastify' {
  interface FastifyInstance { config: ServerConfig }
}
