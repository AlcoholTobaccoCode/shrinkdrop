import { describe, expect, it } from 'vitest';
import type { BatchEvent, Job, JobStatus } from '@tinypng/shared';
import { ApiClient, type UploadRequest } from '../../src/core/cloud/api-client';
import { CloudExecutor } from '../../src/core/cloud/cloud-executor';
import { SseParser } from '../../src/core/cloud/sse';
import type { FileAdapter, SourceFile } from '../../src/core/files/contracts';
import { displayStatus } from '../../src/core/workbench/model';

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await tick(2); }
}

/** 按 API v0.2 行为的假 Server */
class FakeServer {
  requests: Array<{ method: string; path: string; auth?: string; body?: unknown }> = [];
  jobs = new Map<string, Job>();
  streams: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  seq = 0;
  failGetBatch = false;

  job(jobId: string, patch: Partial<Job> = {}): Job {
    return { jobId, batchId: 'b1', source: { kind: 'upload', filename: 'x', size: 4 }, providerId: 'official-tinify', status: 'draft', attempts: 0, outputs: [{ outputId: jobId + '-o', destination: { type: 'download' }, status: 'pending' }], createdAt: '', updatedAt: '', ...patch };
  }

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const path = url.replace('http://srv/api/v1', '');
    const method = init.method ?? 'GET';
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
    this.requests.push({ method, path, auth, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (auth !== 'Bearer t0k') return json(401, { code: 'AUTH_INVALID', message: 'bad', retryable: false, requestId: 'r' });
    if (method === 'POST' && path === '/batches') return json(200, { batchId: 'b1', status: 'draft' });
    if (method === 'POST' && path === '/batches/b1/items') {
      const urls = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
      return json(200, { jobs: urls.map(() => this.add()) });
    }
    if (method === 'POST' && path === '/batches/b1/start') {
      for (const j of this.jobs.values()) if (j.status === 'draft') j.status = 'queued';
      return json(200, {});
    }
    if (method === 'GET' && path === '/batches/b1/events') {
      if (this.failGetBatch && this.streams.length > 5) return json(500, {});
      const stream = new ReadableStream<Uint8Array>({ start: c => { this.streams.push(c); } });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (method === 'GET' && path === '/batches/b1') {
      return json(200, { batchId: 'b1', providerId: 'official-tinify', operations: [], destinations: [], status: 'running', jobs: [...this.jobs.values()], createdAt: '', updatedAt: '' });
    }
    const jobMatch = path.match(/^\/jobs\/([^/]+)(\/.*)?$/);
    if (jobMatch) {
      const j = this.jobs.get(jobMatch[1]!)!;
      if (!jobMatch[2]) return json(200, j);
      if (jobMatch[2] === '/retry') { j.status = 'queued'; return json(200, {}); }
      if (jobMatch[2] === '/cancel') return json(200, {});
      if (jobMatch[2] === '/result') return new Response(new Blob([new Uint8Array(3)], { type: 'image/webp' }));
    }
    if (path === '/batches/b1/archive') return new Response(new Blob([new Uint8Array(9)], { type: 'application/zip' }));
    return json(404, { code: 'BATCH_NOT_FOUND', message: path, retryable: false, requestId: 'r' });
  };

  upload = async (req: UploadRequest) => {
    this.requests.push({ method: 'POST', path: req.url.replace('http://srv/api/v1', '') + ' (multipart)', auth: req.headers.Authorization });
    req.onProgress?.(50, 100);
    await tick(1);
    req.onProgress?.(100, 100);
    return { status: 200, body: JSON.stringify({ jobs: [this.add()] }) };
  };

  add(): Job {
    const j = this.job('j' + String(++this.seq));
    this.jobs.set(j.jobId, j);
    return j;
  }

  /** 推到最新一条流 */
  push(event: BatchEvent): void {
    if (event.type === 'job') {
      const j = this.jobs.get(event.jobId)!;
      j.status = event.status;
      if (event.outputs) j.outputs = event.outputs;
      if (event.status === 'completed' || event.status === 'saving') j.result = { mime: 'image/webp', size: 2, width: 1, height: 1, savedRatio: 0.5 };
    }
    if (event.type === 'job' && event.status === 'completed' && !event.result) event = { ...event, result: { mime: 'image/webp', size: 2, width: 1, height: 1, savedRatio: 0.5 } };
    const c = this.streams.at(-1)!;
    c.enqueue(new TextEncoder().encode('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n'));
  }

  /** 改状态但不推事件（模拟断线期间发生的变化） */
  silently(jobId: string, status: JobStatus, outputs?: Job['outputs']): void {
    const j = this.jobs.get(jobId)!;
    j.status = status;
    if (outputs) j.outputs = outputs;
    if (status === 'completed') j.result = { mime: 'image/webp', size: 2, width: 1, height: 1, savedRatio: 0.5 };
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const file = (id: string): SourceFile => ({ id, name: id + '.png', size: 4, mime: 'image/png', relativePath: id + '.png' });
const adapter: FileAdapter = {
  chooseFiles: async () => [], chooseDirectory: async () => [], read: async () => new Uint8Array(4),
  writeTemp: async () => { throw new Error('no'); }, copyToClipboard: async () => undefined, replaceOriginal: async () => undefined, cleanup: async () => undefined
};

function setup(sse = { idleTimeoutMs: 60, backoffMs: () => 5 }) {
  const server = new FakeServer();
  const api = new ApiClient({ baseUrl: 'http://srv/', getToken: async () => 't0k', fetch: server.fetch, upload: server.upload });
  const exec = new CloudExecutor({ api, adapter, pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] }, sse });
  const states: string[] = [];
  exec.onConnection(s => states.push(s));
  return { server, api, exec, states };
}

describe('SseParser', () => {
  it('分块、多行 data、注释、CRLF', () => {
    const p = new SseParser();
    expect(p.push(': hi\r\nevent: job\r\ndata: {"a":')).toEqual([]);
    expect(p.push('1}\r\n\r\nevent: heartbeat\ndata: x\ndata: y\n\n')).toEqual([{ event: 'job', data: '{"a":1}' }, { event: 'heartbeat', data: 'x\ny' }]);
  });
});

describe('CloudExecutor（D4）', () => {
  it('加图不发任何请求；点开始才建批次 → 上传（带进度）→ /start；全程带 Bearer', async () => {
    const { server, exec } = setup();
    const progress: number[] = [];
    exec.subscribe(items => { const p = items[0]?.progress; if (items[0]?.status === 'uploading' && p !== undefined) progress.push(p); });
    exec.addFiles([file('a'), file('b')]);
    exec.addUrls(['https://img.example.com/c.jpg']);
    expect(server.requests).toHaveLength(0);
    expect(exec.snapshot.every(i => i.status === 'draft')).toBe(true);

    await exec.start();
    const paths = server.requests.map(r => r.method + ' ' + r.path);
    expect(paths[0]).toBe('POST /batches');
    expect(paths.filter(p => p.includes('(multipart)'))).toHaveLength(2);
    expect(paths).toContain('POST /batches/b1/items');
    expect(paths).toContain('POST /batches/b1/start');
    expect(paths).toContain('GET /batches/b1/events');
    expect(server.requests.every(r => r.auth === 'Bearer t0k')).toBe(true);
    expect(server.requests.find(r => r.path === '/batches')?.body).toMatchObject({ providerId: 'official-tinify', destinations: [{ type: 'download' }] });
    expect(progress).toContain(0.5);
    expect(exec.snapshot.map(i => i.status)).toEqual(['queued', 'queued', 'queued']);
    await exec.dispose();
  });

  it('SSE 增量事件跑通批量压缩，partial / output-failed 正确，取消后迟到事件丢弃', async () => {
    const { server, exec } = setup();
    exec.addFiles([file('a'), file('b'), file('c')]);
    await exec.start();
    await until(() => server.streams.length === 1);
    const [a, b, c] = exec.snapshot;
    server.push({ type: 'job', jobId: 'j1', status: 'processing', progress: 0.4 });
    await until(() => a!.status === 'processing');
    expect(a!.progress).toBe(0.4);
    server.push({ type: 'heartbeat', at: '' });
    server.push({ type: 'job', jobId: 'j1', status: 'completed', outputs: [{ outputId: 'j1-o', destination: { type: 'download' }, status: 'completed' }] });
    server.push({ type: 'job', jobId: 'j2', status: 'saving' });
    server.push({ type: 'job', jobId: 'j2', status: 'failed', outputs: [{ outputId: 'j2-o', destination: { type: 'download' }, status: 'failed' }], error: { code: 'OUTPUT_FAILED', message: '保存失败', retryable: true, requestId: 'r' } });
    exec.cancel(c!.id);
    server.push({ type: 'job', jobId: 'j3', status: 'canceled' });
    server.push({ type: 'job', jobId: 'j3', status: 'processing' });
    server.push({ type: 'batch', batchId: 'b1', status: 'partial' });
    await until(() => exec.batchStatus === 'partial');
    await until(() => a!.compressedSize === 2);
    expect(server.requests.some(r => r.path.startsWith('/jobs/j1') && r.method === 'GET')).toBe(false);
    expect(displayStatus(a!)).toBe('completed');
    expect(displayStatus(b!)).toBe('output-failed');
    expect(c!.status).toBe('canceled');
    expect(server.requests.some(r => r.path === '/jobs/j3/cancel')).toBe(true);

    await exec.retry(b!.id, 'outputs');
    expect(server.requests.find(r => r.path === '/jobs/j2/retry')?.body).toEqual({ scope: 'outputs' });
    expect(b!.status).toBe('saving');
    await exec.dispose();
  });

  it('30 秒无事件 → 连接中断 → 自动重连 → 先全量 GET /batches/:id 校正', async () => {
    const { server, exec, states } = setup({ idleTimeoutMs: 40, backoffMs: () => 5 });
    exec.addFiles([file('a'), file('b')]);
    await exec.start();
    await until(() => exec.connection === 'connected');
    // 断线期间状态变了，但没推事件
    server.silently('j1', 'completed', [{ outputId: 'j1-o', destination: { type: 'download' }, status: 'completed' }]);
    server.silently('j2', 'processing');
    await until(() => states.includes('interrupted'), 2000);
    await until(() => server.streams.length >= 2 && exec.connection === 'connected', 2000);
    expect(server.requests.some(r => r.method === 'GET' && r.path === '/batches/b1')).toBe(true);
    const getIndex = server.requests.findIndex(r => r.path === '/batches/b1' && r.method === 'GET');
    const secondStream = server.requests.map((r, i) => (r.path === '/batches/b1/events' ? i : -1)).filter(i => i >= 0)[1]!;
    expect(getIndex).toBeGreaterThan(secondStream);
    expect(exec.snapshot.map(i => i.status)).toEqual(['completed', 'processing']);
    expect(states).toEqual(expect.arrayContaining(['connecting', 'connected', 'interrupted']));
    await exec.dispose();
  });

  it('心跳能让连接保持，不误判中断', async () => {
    const { server, exec, states } = setup({ idleTimeoutMs: 40, backoffMs: () => 5 });
    exec.addFiles([file('a')]);
    await exec.start();
    await until(() => exec.connection === 'connected');
    for (let i = 0; i < 6; i++) { server.push({ type: 'heartbeat', at: '' }); await tick(20); }
    expect(states).not.toContain('interrupted');
    await exec.dispose();
  });

  it('单张下载与 zip 全部下载', async () => {
    const { server, exec } = setup();
    exec.addFiles([file('a')]);
    await exec.start();
    server.push({ type: 'job', jobId: 'j1', status: 'completed' });
    await until(() => exec.snapshot[0]!.status === 'completed');
    const one = await exec.download(exec.snapshot[0]!.id);
    expect(one.filename).toBe('a.webp');
    const zip = await exec.downloadArchive();
    expect(zip.blob.type).toBe('application/zip');
    expect(zip.filename).toMatch(/\.zip$/);
    await exec.dispose();
  });

  it('只允许 download 目的地；错误令牌显示 AUTH_INVALID', async () => {
    const server = new FakeServer();
    const bad = new CloudExecutor({
      api: new ApiClient({ baseUrl: 'http://srv', getToken: async () => 't0k', fetch: server.fetch, upload: server.upload }),
      adapter, pipeline: { providerId: 'official-tinify', operations: [], destinations: [{ type: 'object-storage', profileId: 'x' }] }
    });
    bad.addFiles([file('a')]);
    await bad.start();
    expect(bad.snapshot[0]?.error?.code).toBe('VALIDATION_FAILED');
    expect(server.requests).toHaveLength(0);

    const noAuth = new CloudExecutor({
      api: new ApiClient({ baseUrl: 'http://srv', getToken: async () => 'wrong', fetch: server.fetch, upload: server.upload }),
      adapter, pipeline: { providerId: 'official-tinify', operations: [], destinations: [{ type: 'download' }] }
    });
    noAuth.addFiles([file('a')]);
    await noAuth.start();
    expect(noAuth.snapshot[0]?.error?.code).toBe('AUTH_INVALID');
  });
});
