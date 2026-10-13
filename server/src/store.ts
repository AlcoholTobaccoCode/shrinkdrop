import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Batch, Job, JobStatus, Operation, OutputDestination, ProviderId } from '@tinypng/shared';
import { TERMINAL_JOB_STATUSES } from '@tinypng/shared';
/** Server 内部的批次记录（比对外 Batch 多 ownerTokenId，不含 jobs） */
export interface BatchRow {
    batchId: string;
    ownerTokenId: string;
    providerId: ProviderId;
    operations: Operation[];
    destinations: OutputDestination[];
    createdAt: string;
    updatedAt: string;
}
/** 对外 Job 加内部字段；内部字段不会出现在 API 响应里 */
export interface JobRow extends Job {
    ownerTokenId: string;
    /** 原图临时文件，相对 tmp 目录 */
    inputFile?: string;
    /** 结果临时文件，相对 tmp 目录 */
    resultFile?: string;
    seq: number;
    /** 每次重试递增，旧输出回调不能写入新一轮任务。 */
    revision?: number;
}
const IN_FLIGHT: JobStatus[] = ['queued', 'uploading', 'processing', 'saving'];
export class Store {
    readonly db: Database.Database;
    readonly tmpDir: string;
    constructor(opts: {
        dataDir: string;
        memory?: boolean;
    }) {
        mkdirSync(opts.dataDir, { recursive: true });
        this.tmpDir = join(opts.dataDir, 'tmp');
        mkdirSync(this.tmpDir, { recursive: true });
        this.db = new Database(opts.memory ? ':memory:' : join(opts.dataDir, 'jobs.sqlite'));
        this.db.pragma('journal_mode = WAL');
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        batch_id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(batch_id) ON DELETE CASCADE,
        owner TEXT NOT NULL, status TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_batch ON jobs(batch_id, seq);
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, job_id TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL);
    `);
        this.db.pragma('foreign_keys = ON');
    }
    // ---- 批次 ----
    insertBatch(b: BatchRow): void {
        this.db.prepare('INSERT INTO batches VALUES (?,?,?,?,?)').run(b.batchId, b.ownerTokenId, JSON.stringify(b), b.createdAt, b.updatedAt);
    }
    getBatch(batchId: string): BatchRow | undefined {
        const r = this.db.prepare('SELECT data FROM batches WHERE batch_id=?').get(batchId) as {
            data: string;
        } | undefined;
        return r ? JSON.parse(r.data) : undefined;
    }
    touchBatch(batchId: string, at = new Date().toISOString()): void {
        const b = this.getBatch(batchId);
        if (!b)
            return;
        b.updatedAt = at;
        this.db.prepare('UPDATE batches SET data=?, updated_at=? WHERE batch_id=?').run(JSON.stringify(b), at, batchId);
    }
    // ---- 任务 ----
    insertJob(j: JobRow): void {
        this.db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?)')
            .run(j.jobId, j.batchId, j.ownerTokenId, j.status, j.seq, JSON.stringify(j), j.createdAt, j.updatedAt);
        this.touchBatch(j.batchId);
    }
    getJob(jobId: string): JobRow | undefined {
        const r = this.db.prepare('SELECT data FROM jobs WHERE job_id=?').get(jobId) as {
            data: string;
        } | undefined;
        return r ? JSON.parse(r.data) : undefined;
    }
    listJobs(batchId: string): JobRow[] {
        return (this.db.prepare('SELECT data FROM jobs WHERE batch_id=? ORDER BY seq').all(batchId) as {
            data: string;
        }[]).map((r) => JSON.parse(r.data));
    }
    nextSeq(batchId: string): number {
        const r = this.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM jobs WHERE batch_id=?').get(batchId) as {
            n: number;
        };
        return r.n;
    }
    /**
     * 更新任务。已经是 canceled 的任务不会被改成其他状态（迟到结果不覆盖取消），
     * 除非 allowFromTerminal（用于 retry）。返回更新后的任务；被拒绝时返回 undefined。
     */
    updateJob(jobId: string, patch: Partial<JobRow>, opts: {
        allowFromTerminal?: boolean;
    } = {}): JobRow | undefined {
        const tx = this.db.transaction(() => {
            const cur = this.getJob(jobId);
            if (!cur)
                return undefined;
            if (cur.status === 'canceled' && !opts.allowFromTerminal && patch.status !== undefined && patch.status !== 'canceled')
                return undefined;
            if (cur.status === 'canceled' && !opts.allowFromTerminal && patch.status === undefined)
                return undefined;
            const next: JobRow = { ...cur, ...patch, updatedAt: new Date().toISOString() };
            this.db.prepare('UPDATE jobs SET status=?, data=?, updated_at=? WHERE job_id=?').run(next.status, JSON.stringify(next), next.updatedAt, jobId);
            this.touchBatch(next.batchId, next.updatedAt);
            return next;
        });
        return tx();
    }
    deleteJob(jobId: string): void {
        const j = this.getJob(jobId);
        if (!j)
            return;
        this.removeFiles(j);
        this.db.prepare('DELETE FROM jobs WHERE job_id=?').run(jobId);
        this.touchBatch(j.batchId);
    }
    audit(kind: string, detail: Record<string, unknown>, jobId?: string): void {
        this.db.prepare('INSERT INTO audit (at, job_id, kind, detail) VALUES (?,?,?,?)').run(new Date().toISOString(), jobId ?? null, kind, JSON.stringify(detail));
    }
    // ---- 文件与清理 ----
    filePath(rel: string): string { return join(this.tmpDir, rel); }
    private removeFiles(j: Pick<JobRow, 'inputFile' | 'resultFile'>): void {
        for (const f of [j.inputFile, j.resultFile])
            if (f)
                rmSync(this.filePath(f), { force: true });
    }
    /** 进程启动时调用：中断的任务标 failed（可重试），删除没有任务引用的孤儿文件 */
    recoverOnStartup(): {
        interrupted: number;
        orphans: number;
    } {
        let interrupted = 0;
        const rows = this.db.prepare(`SELECT job_id FROM jobs WHERE status IN (${IN_FLIGHT.map(() => '?').join(',')})`).all(...IN_FLIGHT) as {
            job_id: string;
        }[];
        for (const { job_id } of rows) {
            const j = this.getJob(job_id)!;
            // 已有结果的只差保存，回到 completed，输出标失败，允许“重试输出”
            const patch: Partial<JobRow> = j.result
                ? { status: 'completed', outputs: j.outputs.map((o) => o.status === 'completed' ? o : { ...o, status: 'failed', error: { code: 'OUTPUT_FAILED', message: 'Server 重启，输出中断', retryable: true, requestId: 'startup' } }) }
                : { status: 'failed', error: { code: 'INTERNAL_ERROR', message: 'Server 重启，任务中断，可以重试', retryable: true, requestId: 'startup' } };
            this.updateJob(job_id, patch);
            interrupted++;
        }
        const referenced = new Set<string>();
        for (const { data } of this.db.prepare('SELECT data FROM jobs').all() as {
            data: string;
        }[]) {
            const j = JSON.parse(data) as JobRow;
            if (j.inputFile)
                referenced.add(j.inputFile);
            if (j.resultFile)
                referenced.add(j.resultFile);
        }
        let orphans = 0;
        for (const f of readdirSync(this.tmpDir)) {
            if (!referenced.has(f)) {
                rmSync(this.filePath(f), { force: true, recursive: true });
                orphans++;
            }
        }
        return { interrupted, orphans };
    }
    /** 删除超过 TTL 的已结束批次（含文件）和过期的临时文件 */
    sweepExpired(ttlHours: number, now = Date.now()): {
        batches: number;
        files: number;
    } {
        const cutoff = new Date(now - ttlHours * 3600000).toISOString();
        let batches = 0;
        const old = this.db.prepare('SELECT batch_id FROM batches WHERE updated_at < ?').all(cutoff) as {
            batch_id: string;
        }[];
        for (const { batch_id } of old) {
            const jobs = this.listJobs(batch_id);
            if (jobs.some((j) => !TERMINAL_JOB_STATUSES.includes(j.status) && j.status !== 'draft'))
                continue;
            for (const j of jobs)
                this.removeFiles(j);
            this.db.prepare('DELETE FROM batches WHERE batch_id=?').run(batch_id);
            batches++;
        }
        let files = 0;
        // 仍被任务引用的文件随批次一起清理，避免长队列的输入被单独删掉。
        const referenced = new Set<string>();
        for (const { data } of this.db.prepare('SELECT data FROM jobs').all() as {
            data: string;
        }[]) {
            const j = JSON.parse(data) as JobRow;
            if (j.inputFile)
                referenced.add(j.inputFile);
            if (j.resultFile)
                referenced.add(j.resultFile);
        }
        for (const f of readdirSync(this.tmpDir)) {
            const p = this.filePath(f);
            if (!referenced.has(f) && existsSync(p) && statSync(p).mtimeMs < now - ttlHours * 3600000) {
                rmSync(p, { force: true, recursive: true });
                files++;
            }
        }
        return { batches, files };
    }
    close(): void { this.db.close(); }
}
/** 去掉内部字段，生成对外 Job */
export function toPublicJob(j: JobRow): Job {
    const { ownerTokenId: _o, inputFile: _i, resultFile: _r, seq: _s, revision: _v, ...pub } = j;
    return pub;
}
export function toPublicBatch(b: BatchRow, jobs: JobRow[], status: Batch['status']): Batch {
    const { ownerTokenId: _o, ...rest } = b;
    return { ...rest, status, jobs: jobs.map(toPublicJob) };
}
