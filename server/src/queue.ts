import { readFile, writeFile, rm } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { LIMITS, deriveBatchStatus, type ApiError, type JobOutput } from '@tinypng/shared';
import type { ServerConfig } from './config';
import type { ProviderService } from './providers/service';
import { Store, type JobRow } from './store';
import { AppError } from './errors';
import { EventHub, jobEvent } from './sse';
import { inspectImage } from './validation';
import { readResult } from './results';
export type OutputWriter = (job: JobRow, output: JobOutput) => Promise<void>;
export const providerAuditContext = new AsyncLocalStorage<{
    actor: string;
    jobId: string;
}>();
const errorBody = (error: unknown, job: JobRow): ApiError => error instanceof AppError ? error.toBody(job.jobId) : new AppError('PROVIDER_ERROR', '图片处理失败，请稍后重试', { providerId: job.providerId, retryable: true }).toBody(job.jobId);
//#region 全局任务调度
export class JobQueue {
    private pending: string[] = [];
    private active = new Map<string, {
        controller: AbortController;
        promise: Promise<void>;
    }>();
    private closed = false;
    constructor(readonly store: Store, private providers: ProviderService, private events: EventHub, private config: ServerConfig, private outputWriter: OutputWriter = async () => { }) { }
    publish(job: JobRow): void {
        this.events.emit(job.batchId, jobEvent(job));
        this.events.emit(job.batchId, { type: 'batch', batchId: job.batchId, status: deriveBatchStatus(this.store.listJobs(job.batchId)) });
    }
    enqueue(ids: string[]): void {
        for (const id of ids)
            if (!this.pending.includes(id))
                this.pending.push(id);
        queueMicrotask(() => this.pump());
    }
    cancel(job: JobRow, actor: string): JobRow {
        if (['completed', 'failed', 'canceled'].includes(job.status))
            return job;
        const canceled = this.store.updateJob(job.jobId, { status: 'canceled', progress: undefined })!;
        this.pending = this.pending.filter(id => id !== job.jobId);
        this.active.get(job.jobId)?.controller.abort();
        this.store.audit('job.canceled', { actor, batchId: job.batchId, previousStatus: job.status }, job.jobId);
        this.publish(canceled);
        return canceled;
    }
    private pump(): void {
        if (this.closed)
            return;
        while (this.active.size < Math.min(this.config.concurrency, LIMITS.concurrency) && this.pending.length) {
            const id = this.pending.shift()!;
            const job = this.store.getJob(id);
            if (job?.status !== 'queued')
                continue;
            const controller = new AbortController();
            const promise = Promise.resolve().then(() => this.run(job, controller)).finally(() => { this.active.delete(id); this.pump(); });
            this.active.set(id, { controller, promise });
        }
    }
    private current(id: string, controller: AbortController): boolean { const job = this.store.getJob(id); return !this.closed && !controller.signal.aborted && this.active.get(id)?.controller === controller && !!job && job.status !== 'canceled'; }
    private async run(initial: JobRow, controller: AbortController): Promise<void> {
        let job = initial;
        try {
            if (!job.inputFile || !job.input)
                throw new AppError('INVALID_STATE', '原图文件不可用，请重新添加图片');
            const data = await readFile(this.store.filePath(job.inputFile));
            const batch = this.store.getBatch(job.batchId)!;
            for (let retry = 0;; retry++) {
                if (!this.current(job.jobId, controller))
                    return;
                job = this.store.updateJob(job.jobId, { status: 'processing', attempts: job.attempts + 1, error: undefined, progress: 0 })!;
                this.publish(job);
                try {
                    const result = await this.executeWithDeadline(job, data, batch.operations, controller.signal);
                    if (!this.current(job.jobId, controller))
                        return;
                    const info = await inspectImage(result.data, result.mimeType, this.config.maxFileBytes);
                    if (!this.current(job.jobId, controller))
                        return;
                    const resultFile = `${job.jobId}.result`;
                    try {
                        await writeFile(this.store.filePath(resultFile), result.data, { mode: 0o600 });
                    }
                    catch {
                        throw new AppError('OUTPUT_FAILED', '结果暂存失败，请检查Server存储空间');
                    }
                    if (!this.current(job.jobId, controller)) {
                        await rm(this.store.filePath(resultFile), { force: true });
                        return;
                    }
                    job = this.store.updateJob(job.jobId, { status: 'saving', resultFile, accountId: result.accountId, result: { ...info, savedRatio: 1 - info.size / job.input!.size }, progress: 1 })!;
                    this.publish(job);
                    await this.saveOutputs(job, () => this.current(job.jobId, controller));
                    return;
                }
                catch (error) {
                    if (!this.current(job.jobId, controller))
                        return;
                    const body = errorBody(error, job);
                    this.store.audit('job.attempt.failed', { actor: job.ownerTokenId, providerId: job.providerId, attempt: job.attempts, errorCode: body.code, retryable: body.retryable }, job.jobId);
                    // 匿名Provider已在内部做有限轮换，队列不能再套一层重试放大请求次数。
                    if (job.providerId === 'anonymous-tinify' || !body.retryable || retry >= Math.min(this.config.maxRetries, LIMITS.maxRetries))
                        throw error;
                }
            }
        }
        catch (error) {
            if (!this.current(job.jobId, controller))
                return;
            const failed = this.store.updateJob(job.jobId, { status: 'failed', error: errorBody(error, job), progress: undefined });
            if (failed)
                this.publish(failed);
        }
    }
    private async executeWithDeadline(job: JobRow, data: Uint8Array, operations: Parameters<ProviderService['execute']>[0]['operations'], parent: AbortSignal) {
        const child = new AbortController();
        const result = new Promise<Awaited<ReturnType<ProviderService['execute']>>>((resolve, reject) => {
            const abort = () => { child.abort(); reject(new AppError('INVALID_STATE', '任务已取消')); };
            parent.addEventListener('abort', abort, { once: true });
            const timer = setTimeout(() => { child.abort(); reject(new AppError('PROVIDER_TIMEOUT', '图片处理超时', { providerId: job.providerId, retryable: true })); }, Math.min(this.config.providerTimeoutMs, LIMITS.providerTimeoutMs));
            timer.unref();
            if (parent.aborted)
                abort();
            Promise.resolve().then(() => { child.signal.throwIfAborted(); return providerAuditContext.run({ actor: job.ownerTokenId, jobId: job.jobId }, () => this.providers.execute({ providerId: job.providerId, operations, data, mimeType: job.input!.mime, signal: child.signal })); }).then(resolve, reject).finally(() => { clearTimeout(timer); parent.removeEventListener('abort', abort); });
            // race超时或取消时也立即释放监听器，不等待不响应abort的Provider。
            child.signal.addEventListener('abort', () => { clearTimeout(timer); parent.removeEventListener('abort', abort); }, { once: true });
        });
        return result;
    }
    async saveOutputs(initial: JobRow, isCurrent: () => boolean = () => {
        const current = this.store.getJob(initial.jobId);
        return !!current && current.status !== 'canceled' && (current.revision ?? 0) === (initial.revision ?? 0);
    }): Promise<JobRow | undefined> {
        let job = initial;
        for (const output of job.outputs) {
            if (output.status === 'completed')
                continue;
            if (!isCurrent())
                return;
            let outputs = job.outputs.map(o => o.outputId === output.outputId ? { ...o, status: 'saving' as const, error: undefined } : o);
            job = this.store.updateJob(job.jobId, { status: 'saving', outputs })!;
            this.publish(job);
            try {
                await readResult(this.store, job);
                await this.outputWriter(job, output);
                if (!isCurrent())
                    return;
                outputs = job.outputs.map(o => o.outputId === output.outputId ? { ...o, status: 'completed' as const, url: `/api/v1/jobs/${job.jobId}/result`, error: undefined } : o);
            }
            catch {
                if (!isCurrent())
                    return;
                outputs = job.outputs.map(o => o.outputId === output.outputId ? { ...o, status: 'failed' as const, error: new AppError('OUTPUT_FAILED', '图片已处理，保存失败；可以重试保存', { retryable: true }).toBody(job.jobId) } : o);
            }
            job = this.store.updateJob(job.jobId, { outputs })!;
            this.publish(job);
        }
        if (!isCurrent())
            return;
        job = this.store.updateJob(job.jobId, { status: 'completed', error: undefined, progress: 1 })!;
        this.publish(job);
        this.store.audit('job.completed', { actor: job.ownerTokenId, providerId: job.providerId, accountId: job.accountId, outputs: job.outputs.map(o => ({ outputId: o.outputId, status: o.status })) }, job.jobId);
        return job;
    }
    async close(): Promise<void> { this.closed = true; this.pending = []; for (const { controller } of this.active.values())
        controller.abort(); await Promise.allSettled([...this.active.values()].map(a => a.promise)); }
}
//#endregion
