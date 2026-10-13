import { SSE_HEARTBEAT_INTERVAL_MS, type BatchEvent, type Job } from '@tinypng/shared';
import type { FastifyReply } from 'fastify';
//#region 批次事件与心跳
export function encodeEvent(event: BatchEvent): string { return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`; }
export function jobEvent(job: Job): BatchEvent {
    return { type: 'job', jobId: job.jobId, status: job.status, progress: job.progress, outputs: job.outputs, error: job.error, result: job.result };
}
export class EventHub {
    private listeners = new Map<string, Set<(event: BatchEvent) => void>>();
    private disposers = new Set<() => void>();
    subscribe(batchId: string, listener: (event: BatchEvent) => void): () => void {
        const group = this.listeners.get(batchId) ?? new Set();
        group.add(listener);
        this.listeners.set(batchId, group);
        const timer = setInterval(() => listener({ type: 'heartbeat', at: new Date().toISOString() }), SSE_HEARTBEAT_INTERVAL_MS);
        timer.unref();
        const off = () => { clearInterval(timer); group.delete(listener); if (group.size === 0)
            this.listeners.delete(batchId); this.disposers.delete(off); };
        this.disposers.add(off);
        return off;
    }
    emit(batchId: string, event: BatchEvent): void { for (const listener of this.listeners.get(batchId) ?? [])
        listener(event); }
    onClose(cleanup: () => void): () => void { this.disposers.add(cleanup); return () => this.disposers.delete(cleanup); }
    close(): void { for (const off of [...this.disposers])
        off(); this.listeners.clear(); }
}
export function openEventStream(reply: FastifyReply, hub: EventHub, batchId: string, initial: BatchEvent | BatchEvent[]): void {
    reply.hijack();
    for (const [name, value] of Object.entries(reply.getHeaders()))
        if (value !== undefined)
            reply.raw.setHeader(name, value);
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Request-Id': String(reply.getHeader('X-Request-Id') ?? '') });
    // 补发当前任务事件，覆盖客户端GET完成到SSE订阅建立之间的状态变化。
    reply.raw.write((Array.isArray(initial) ? initial : [initial]).map(encodeEvent).join(''));
    const off = hub.subscribe(batchId, event => {
        if (reply.raw.destroyed) {
            off();
            return;
        }
        // 慢客户端不能无限积压；断开后客户端按合同拉全量状态再重连。
        if (!reply.raw.write(encodeEvent(event)))
            reply.raw.destroy();
    });
    const cleanup = () => { off(); unregister(); if (!reply.raw.destroyed)
        reply.raw.end(); };
    const unregister = hub.onClose(cleanup);
    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);
}
//#endregion
