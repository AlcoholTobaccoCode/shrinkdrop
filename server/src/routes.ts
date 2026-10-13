import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { deriveBatchStatus, LIMITS, type AddItemsResponse, type ImageInfo, type JobSource } from '@tinypng/shared';
import { assertOwner } from './auth';
import { AppError } from './errors';
import { Store, toPublicBatch, toPublicJob, type BatchRow, type JobRow } from './store';
import { validateBatch, inspectImage, urlItemsSchema, retrySchema } from './validation';
import { fetchUrlImage, type UrlFetchOptions } from './url-input';
import { JobQueue } from './queue';
import { EventHub, openEventStream, jobEvent } from './sse';
import { createArchive, contentDisposition, readResult, resultName } from './results';
import type { ProviderService } from './providers/service';
export interface ServerRuntime {
    store: Store;
    queue: JobQueue;
    events: EventHub;
    providers: ProviderService;
}
export type UrlFetcher = typeof fetchUrlImage;
export interface RouteOptions {
    urlFetcher?: UrlFetcher;
    urlFetchOptions?: UrlFetchOptions;
}
//#region 资源隔离与批次操作
export function registerRoutes(app: FastifyInstance, runtime: ServerRuntime, options: RouteOptions = {}): void {
    const { store, queue, events, providers } = runtime;
    const uploads = new Map<string, number>();
    const downloads = new Set<() => void>();
    const imports = new Set<AbortController>();
    let closing = false;
    app.addHook('preClose', async () => {
        closing = true;
        for (const controller of imports) controller.abort();
        for (const abort of [...downloads]) abort();
        downloads.clear();
    });
    const getBatch = (req: FastifyRequest, id: string): BatchRow => { const batch = store.getBatch(id); assertOwner(req, batch?.ownerTokenId, 'batch'); return batch!; };
    const getJob = (req: FastifyRequest, id: string): JobRow => { const job = store.getJob(id); assertOwner(req, job?.ownerTokenId, 'job'); return job!; };
    const fullBatch = (batch: BatchRow) => { const jobs = store.listJobs(batch.batchId); return toPublicBatch(batch, jobs, deriveBatchStatus(jobs)); };
    const params = (req: FastifyRequest) => req.params as {
        batchId: string;
        jobId: string;
    };
    app.get('/api/v1/providers', async () => providers.list());
    app.get('/api/v1/providers/:id/usage', async (req) => providers.usage((req.params as {
        id: string;
    }).id));
    app.post('/api/v1/providers/:id/usage/refresh', async (req) => providers.refreshUsage((req.params as {
        id: string;
    }).id));
    app.get('/api/v1/storage/profiles', async () => []);
    app.post('/api/v1/batches', async (req, reply) => {
        const input = validateBatch(req.body, providers.list());
        const at = new Date().toISOString();
        const batch: BatchRow = { ...input, batchId: randomUUID(), ownerTokenId: req.tokenId, createdAt: at, updatedAt: at };
        store.insertBatch(batch);
        store.audit('batch.created', { actor: req.tokenId, batchId: batch.batchId, providerId: batch.providerId, operations: batch.operations, destinations: batch.destinations });
        return reply.status(201).send(fullBatch(batch));
    });
    app.get('/api/v1/batches/:batchId', async (req) => fullBatch(getBatch(req, params(req).batchId)));
    app.get('/api/v1/jobs/:jobId', async (req) => toPublicJob(getJob(req, params(req).jobId)));
    app.post('/api/v1/batches/:batchId/items', async (req, reply) => {
        const batch = getBatch(req, params(req).batchId);
        const active = uploads.get(req.tokenId) ?? 0;
        if (active >= app.config.maxUploadsPerToken)
            throw new AppError('RATE_LIMITED', '正在添加的图片太多，请稍后重试', { retryable: true });
        uploads.set(req.tokenId, active + 1);
        store.touchBatch(batch.batchId);
        const controller = new AbortController();
        const abortRequest = () => controller.abort();
        const abortResponse = () => { if (!reply.raw.writableFinished) controller.abort(); };
        imports.add(controller);
        req.raw.once('aborted', abortRequest);
        reply.raw.once('close', abortResponse);
        if (closing || req.raw.aborted || reply.raw.destroyed) controller.abort();
        const inserted: JobRow[] = [];
        const stage = async (data: Uint8Array, info: ImageInfo, source: JobSource) => {
            controller.signal.throwIfAborted();
            const jobId = randomUUID();
            const inputFile = `${jobId}.input`;
            const at = new Date().toISOString();
            const job: JobRow = { jobId, batchId: batch.batchId, ownerTokenId: req.tokenId, providerId: batch.providerId, source, input: info, inputFile, seq: 0, status: 'draft', attempts: 0, outputs: batch.destinations.map(destination => ({ outputId: randomUUID(), destination, status: 'pending' })), createdAt: at, updatedAt: at };
            inserted.push(job);
            await writeFile(store.filePath(inputFile), data, { mode: 0o600 });
            controller.signal.throwIfAborted();
        };
        try {
            if (req.isMultipart()) {
                for await (const part of req.parts()) {
                    if (part.type !== 'file' || part.fieldname !== 'files')
                        throw new AppError('VALIDATION_FAILED', '请使用files字段上传图片');
                    const data = await part.toBuffer();
                    if (part.file.truncated)
                        throw new AppError('FILE_TOO_LARGE', '图片不能超过20MB');
                    const info = await inspectImage(data, part.mimetype, app.config.maxFileBytes);
                    controller.signal.throwIfAborted();
                    await stage(data, info, { kind: 'upload', filename: part.filename || 'image', size: data.byteLength });
                }
                if (!inserted.length)
                    throw new AppError('VALIDATION_FAILED', '请选择需要处理的图片');
            }
            else {
                const parsed = urlItemsSchema.safeParse(req.body);
                if (!parsed.success)
                    throw new AppError('VALIDATION_FAILED', '请填写有效的图片网址列表');
                const provider = providers.list().find(p => p.id === batch.providerId);
                if (!provider?.capabilities.urlInput)
                    throw new AppError('OPERATION_UNSUPPORTED', '当前线路不支持网址输入', { providerId: batch.providerId });
                for (const url of parsed.data.urls) {
                    controller.signal.throwIfAborted();
                    const image = await (options.urlFetcher ?? fetchUrlImage)(url, controller.signal, { maxBytes: app.config.maxFileBytes, timeoutMs: app.config.providerTimeoutMs, ...options.urlFetchOptions });
                    // 下载实现可能迟到返回；取消后仍须拦住草稿写入。
                    controller.signal.throwIfAborted();
                    await stage(image.data, image.info, { kind: 'url', url, host: new URL(url).hostname });
                }
            }
            // 逐张校验并暂存，内存不累计整批Buffer；全部成功才一次提交草稿。
            controller.signal.throwIfAborted();
            store.db.transaction(() => {
                for (const job of inserted) {
                    job.seq = store.nextSeq(batch.batchId);
                    store.insertJob(job);
                }
            })();
            for (const job of inserted)
                queue.publish(job);
            store.audit('batch.items.added', { actor: req.tokenId, batchId: batch.batchId, jobIds: inserted.map(j => j.jobId) });
            const response: AddItemsResponse = { jobs: inserted.map(toPublicJob) };
            return reply.status(201).send(response);
        }
        catch (error) {
            for (const job of inserted) {
                store.deleteJob(job.jobId);
                if (job.inputFile)
                    await rm(store.filePath(job.inputFile), { force: true });
            }
            throw error;
        }
        finally {
            imports.delete(controller);
            req.raw.removeListener('aborted', abortRequest);
            reply.raw.removeListener('close', abortResponse);
            const n = (uploads.get(req.tokenId) ?? 1) - 1;
            if (n)
                uploads.set(req.tokenId, n);
            else
                uploads.delete(req.tokenId);
        }
    });
    app.delete('/api/v1/batches/:batchId/items/:jobId', async (req, reply) => {
        const batch = getBatch(req, params(req).batchId);
        const job = getJob(req, params(req).jobId);
        if (job.batchId !== batch.batchId)
            throw new AppError('JOB_NOT_FOUND', '任务不存在');
        if (job.status !== 'draft')
            throw new AppError('INVALID_STATE', '已经开始的图片不能删除');
        store.deleteJob(job.jobId);
        store.audit('job.deleted', { actor: req.tokenId, batchId: batch.batchId }, job.jobId);
        events.emit(batch.batchId, { type: 'batch', batchId: batch.batchId, status: deriveBatchStatus(store.listJobs(batch.batchId)) });
        return reply.status(204).send();
    });
    app.post('/api/v1/batches/:batchId/start', async (req) => {
        const batch = getBatch(req, params(req).batchId);
        // 每次开始都复核线路与操作合同；开关关闭后不能靠旧草稿绕过。
        validateBatch({ providerId: batch.providerId, operations: batch.operations, destinations: batch.destinations }, providers.list());
        const drafts = store.listJobs(batch.batchId).filter(j => j.status === 'draft');
        if (!drafts.length)
            throw new AppError('INVALID_STATE', '没有等待开始的图片');
        for (const job of drafts) {
            const queued = store.updateJob(job.jobId, { status: 'queued' })!;
            queue.publish(queued);
        }
        store.audit('batch.started', { actor: req.tokenId, batchId: batch.batchId, jobIds: drafts.map(j => j.jobId) });
        queue.enqueue(drafts.map(j => j.jobId));
        return fullBatch(store.getBatch(batch.batchId)!);
    });
    app.post('/api/v1/jobs/:jobId/cancel', async (req) => toPublicJob(queue.cancel(getJob(req, params(req).jobId), req.tokenId)));
    app.post('/api/v1/batches/:batchId/cancel', async (req) => {
        const batch = getBatch(req, params(req).batchId);
        for (const job of store.listJobs(batch.batchId))
            queue.cancel(job, req.tokenId);
        return fullBatch(store.getBatch(batch.batchId)!);
    });
    app.post('/api/v1/jobs/:jobId/retry', async (req) => {
        const job = getJob(req, params(req).jobId);
        const parsed = retrySchema.safeParse(req.body);
        if (!parsed.success)
            throw new AppError('VALIDATION_FAILED', '请选择完整重试或只重试输出');
        if (!['completed', 'failed', 'canceled'].includes(job.status))
            throw new AppError('INVALID_STATE', '请等待当前任务结束后再重试');
        const batch = getBatch(req, job.batchId);
        if (parsed.data.scope === 'outputs') {
            if (job.status === 'canceled' || !job.result || !job.resultFile || !job.outputs.some(o => o.status === 'failed'))
                throw new AppError('INVALID_STATE', '当前任务没有可以重试的输出');
            const retry = store.updateJob(job.jobId, { status: 'saving', error: undefined, revision: (job.revision ?? 0) + 1 }, { allowFromTerminal: true })!;
            store.audit('job.retry.outputs', { actor: req.tokenId, batchId: job.batchId }, job.jobId);
            const saved = await queue.saveOutputs(retry);
            return toPublicJob(saved ?? store.getJob(job.jobId)!);
        }
        validateBatch({ providerId: batch.providerId, operations: batch.operations, destinations: batch.destinations }, providers.list());
        if (job.status === 'completed' && !job.outputs.some(o => o.status === 'failed'))
            throw new AppError('INVALID_STATE', '图片已经处理完成');
        if (job.resultFile)
            await rm(store.filePath(job.resultFile), { force: true });
        const queued = store.updateJob(job.jobId, { status: 'queued', revision: (job.revision ?? 0) + 1, result: undefined, resultFile: undefined, accountId: undefined, error: undefined, progress: undefined, outputs: job.outputs.map(o => ({ ...o, status: 'pending', url: undefined, error: undefined })) }, { allowFromTerminal: true })!;
        store.audit('job.retry.all', { actor: req.tokenId, batchId: job.batchId }, job.jobId);
        queue.publish(queued);
        queue.enqueue([job.jobId]);
        return toPublicJob(queued);
    });
    app.get('/api/v1/jobs/:jobId/result', async (req, reply) => {
        const job = getJob(req, params(req).jobId);
        const data = await readResult(store, job);
        return reply.header('Content-Type', job.result!.mime).header('Content-Disposition', contentDisposition(resultName(job))).header('Cache-Control', 'private, no-store').send(data);
    });
    app.get('/api/v1/batches/:batchId/archive', async (req, reply) => {
        const batch = getBatch(req, params(req).batchId);
        const data = await createArchive(store, store.listJobs(batch.batchId));
        if (closing || reply.raw.destroyed) { data.destroy(); throw new AppError('PROVIDER_UNAVAILABLE', '下载已中断，请稍后重试', {retryable: true}); }
        const abort = () => { data.destroy(); reply.raw.destroy(); };
        const forget = () => { downloads.delete(abort); };
        downloads.add(abort);
        reply.raw.once('close', () => { data.destroy(); forget(); });
        reply.raw.once('finish', forget);
        return reply.header('Content-Type', 'application/zip').header('Content-Disposition', contentDisposition(`batch-${batch.batchId}.zip`)).header('Cache-Control', 'private, no-store').send(data);
    });
    app.get('/api/v1/batches/:batchId/events', async (req, reply) => {
        const batch = getBatch(req, params(req).batchId);
        const jobs = store.listJobs(batch.batchId);
        openEventStream(reply, events, batch.batchId, [{ type: 'batch', batchId: batch.batchId, status: deriveBatchStatus(jobs) }, ...jobs.map(jobEvent)]);
    });
}
//#endregion
