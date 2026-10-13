import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { ApiError } from '@tinypng/shared';
import type { ServerConfig } from './config';
import { AppError } from './errors';
import { registerAuth } from './auth';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS } from '@tinypng/shared';
import { Store } from './store';
import { EventHub } from './sse';
import { JobQueue, providerAuditContext, type OutputWriter } from './queue';
import { registerRoutes, type RouteOptions, type ServerRuntime } from './routes';
import { createProviderService, type ProviderService } from './providers/service';
const REDACT = /(authorization|api_key|apikey|secret|token)/i;
export function buildApp(config: ServerConfig, opts: RouteOptions & {
    logger?: boolean;
    providers?: ProviderService;
    dataDir?: string;
    store?: Store;
    outputWriter?: OutputWriter;
} = {}): FastifyInstance {
    const app = Fastify({
        logger: opts.logger ? { redact: { paths: ['req.headers.authorization'], censor: '[redacted]' } } : false,
        bodyLimit: config.maxFileBytes + 1024 * 1024,
        genReqId: (req) => {
            const incoming = req.headers['x-request-id'];
            return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
        },
    });
    app.decorate('config', config);
    const ephemeral = !opts.dataDir && !opts.store ? mkdtempSync(join(tmpdir(), 'tinypng-server-')) : undefined;
    const store = opts.store ?? new Store({ dataDir: opts.dataDir ?? ephemeral! });
    store.recoverOnStartup();
    store.sweepExpired(Math.min(config.tmpTtlHours, LIMITS.tmpTtlHours));
    let auditSinkOpen = true;
    const providers = opts.providers ?? createProviderService(config, { audit: record => {
            if (!auditSinkOpen)
                return;
            const context = providerAuditContext.getStore();
            store.audit('provider.request', { actor: context?.actor ?? 'system', ...record }, context?.jobId);
        } });
    const events = new EventHub();
    const queue = new JobQueue(store, providers, events, config, opts.outputWriter);
    const runtime: ServerRuntime = { store, providers, events, queue };
    app.decorate('runtime', runtime);
    const sweep = setInterval(() => store.sweepExpired(Math.min(config.tmpTtlHours, LIMITS.tmpTtlHours)), 60000);
    sweep.unref();
    void app.register(multipart, { limits: { fileSize: Math.min(config.maxFileBytes, LIMITS.maxFileBytes), files: 100, fields: 0, parts: 100 }, throwFileSizeLimit: true });
    app.addHook('onRequest', async (req, reply) => { reply.header('X-Request-Id', req.id); });
    void app.register(cors, { origin: config.corsOrigins, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'], exposedHeaders: ['Content-Disposition', 'X-Request-Id'] });
    registerAuth(app, config);
    app.get('/api/v1/whoami', async (req) => ({ tokenId: req.tokenId }));
    app.setErrorHandler((rawErr, req, reply) => {
        const err = rawErr as Error & {
            validation?: unknown;
            code?: string;
        };
        let e: AppError;
        if (err instanceof AppError)
            e = err;
        else if (err.validation)
            e = new AppError('VALIDATION_FAILED', err.message);
        else if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || err.code === 'FST_REQ_FILE_TOO_LARGE')
            e = new AppError('FILE_TOO_LARGE', '图片不能超过20MB');
        else if (err.code?.startsWith('FST_PARTS_LIMIT') || err.code?.startsWith('FST_FILES_LIMIT') || err.code?.startsWith('FST_FIELDS_LIMIT'))
            e = new AppError('VALIDATION_FAILED', '每次最多添加100张图片');
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
    registerRoutes(app, runtime, opts);
    app.addHook('preClose', async () => { events.close(); });
    app.addHook('onClose', async () => {
        clearInterval(sweep);
        await queue.close();
        auditSinkOpen = false;
        providers.close();
        if (!opts.store)
            store.close();
        if (ephemeral)
            rmSync(ephemeral, { recursive: true, force: true });
    });
    return app;
}
declare module 'fastify' {
    interface FastifyInstance {
        config: ServerConfig;
        runtime: ServerRuntime;
    }
}
