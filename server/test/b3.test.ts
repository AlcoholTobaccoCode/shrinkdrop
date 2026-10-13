import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, toPublicJob, type JobRow } from '../src/store';

const now = () => new Date().toISOString();
let dir: string; let s: Store;
const job = (id: string, extra: Partial<JobRow> = {}): JobRow => ({
  jobId: id, batchId: 'b1', ownerTokenId: 'alice', seq: 0, source: { kind: 'upload', filename: 'a.png', size: 1 },
  providerId: 'official-tinify', status: 'draft', attempts: 0, outputs: [{ outputId: 'o1', destination: { type: 'download' }, status: 'pending' }],
  createdAt: now(), updatedAt: now(), ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'store-'));
  s = new Store({ dataDir: dir });
  s.insertBatch({ batchId: 'b1', ownerTokenId: 'alice', providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }], createdAt: now(), updatedAt: now() });
});

describe('B3 存储', () => {
  it('任务持久化，重开数据库还在', () => {
    s.insertJob(job('j1')); s.close();
    const s2 = new Store({ dataDir: dir });
    expect(s2.getJob('j1')?.status).toBe('draft');
    expect(s2.listJobs('b1')).toHaveLength(1);
  });
  it('迟到结果不覆盖 canceled', () => {
    s.insertJob(job('j1', { status: 'processing' }));
    s.updateJob('j1', { status: 'canceled' });
    expect(s.updateJob('j1', { status: 'completed' })).toBeUndefined();
    expect(s.getJob('j1')?.status).toBe('canceled');
    expect(s.updateJob('j1', { status: 'queued' }, { allowFromTerminal: true })?.status).toBe('queued');
  });
  it('重启后处理中的任务标 failed 可重试；只差保存的回到 completed 且输出失败', () => {
    writeFileSync(s.filePath('in1'), 'x'); writeFileSync(s.filePath('orphan'), 'x');
    s.insertJob(job('j1', { status: 'processing', inputFile: 'in1' }));
    s.insertJob(job('j2', { status: 'saving', result: { mime: 'image/png', size: 1, width: 1, height: 1, savedRatio: 0.5 } }));
    s.insertJob(job('j3', { status: 'draft' }));
    const r = s.recoverOnStartup();
    expect(r).toEqual({ interrupted: 2, orphans: 1 });
    expect(s.getJob('j1')).toMatchObject({ status: 'failed', error: { retryable: true } });
    expect(s.getJob('j2')?.status).toBe('completed');
    expect(s.getJob('j2')?.outputs[0]?.status).toBe('failed');
    expect(s.getJob('j3')?.status).toBe('draft');
    expect(existsSync(s.filePath('in1'))).toBe(true);
    expect(existsSync(s.filePath('orphan'))).toBe(false);
  });
  it('超过 TTL 的批次和文件被删除，运行中的批次保留', () => {
    writeFileSync(s.filePath('in1'), 'x');
    s.insertJob(job('j1', { status: 'completed', inputFile: 'in1' }));
    const old = new Date(Date.now() - 2 * 86400_000);
    utimesSync(s.filePath('in1'), old, old);
    s.db.prepare('UPDATE batches SET updated_at=?').run(old.toISOString());
    expect(s.sweepExpired(24).batches).toBe(1);
    expect(s.getJob('j1')).toBeUndefined();
    expect(existsSync(s.filePath('in1'))).toBe(false);
  });
  it('对外 Job 不含内部字段', () => {
    const p = toPublicJob(job('j1', { inputFile: 'x', resultFile: 'y' }));
    expect(Object.keys(p)).not.toContain('ownerTokenId');
    expect(Object.keys(p)).not.toContain('inputFile');
  });
});

it('TTL不删除仍在处理的任务输入，更新任务会延长批次期限',()=>{
  const old=new Date(Date.now()-2*86400_000);
  writeFileSync(s.filePath('active'), 'x');utimesSync(s.filePath('active'),old,old);
  s.insertJob(job('active-job',{status:'processing',inputFile:'active'}));
  s.db.prepare('UPDATE batches SET updated_at=?').run(old.toISOString());
  s.sweepExpired(24);expect(existsSync(s.filePath('active'))).toBe(true);
  s.updateJob('active-job',{status:'completed'});
  expect(s.sweepExpired(24).batches).toBe(0);
});
