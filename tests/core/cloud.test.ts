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
  it('dispose 取消重连校正 GET，忽略取消的迟到响应不能改写任务状态', async () => {
    const server = new FakeServer();
    const originalFetch = server.fetch;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let recoverySignal: AbortSignal | null | undefined;
    let entered = false;
    const api = new ApiClient({ baseUrl: 'http://srv', getToken: async () => 't0k', upload: server.upload, fetch: async (url, init) => {
      if (url.endsWith('/batches/b1')) { entered = true; recoverySignal = init?.signal; await gate; }
      return originalFetch(url, init);
    } });
    const exec = new CloudExecutor({ api, adapter, pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] }, sse: { idleTimeoutMs: 500, backoffMs: () => 1 } });
    exec.addFiles([file('a')]);
    await exec.start();
    await until(() => server.streams.length === 1);
    server.streams[0]!.close();
    await until(() => entered);
    const before = exec.snapshot[0]!.status;
    server.silently('j1', 'completed');
    const dispose = exec.dispose();
    try {
      expect(await Promise.race([dispose.then(() => true), tick(50).then(() => false)])).toBe(true);
      expect(recoverySignal?.aborted).toBe(true);
    } finally {
      release();
      await dispose;
    }
    await tick();
    expect(exec.snapshot[0]?.status).toBe(before);
  });

  it.each(['processing', 'completed'] as const)('retry已被接受但响应丢失时GET恢复%s，不能回滚成canceled或二次收费', async status => {
    const server = new FakeServer();
    const originalFetch = server.fetch;
    let retries = 0;
    const api = new ApiClient({ baseUrl: 'http://srv', getToken: async () => 't0k', upload: server.upload, fetch: async (url, init) => {
      const response = await originalFetch(url, init);
      if (url.endsWith('/retry')) { retries++; server.silently('j1', status); throw new Error('retry response lost'); }
      return response;
    } });
    const exec = new CloudExecutor({ api, adapter, pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] } });
    exec.addFiles([file('a')]);
    await exec.start();
    server.silently('j1', 'canceled');
    await exec.refetch();
    await exec.retry(exec.snapshot[0]!.id, 'all');
    expect(exec.snapshot[0]?.status).toBe(status);
    expect(retries).toBe(1);
    await exec.dispose();
  });

  it('retry响应和GET都断网时记住未确认动作，恢复后只GET，不盲重发Provider retry', async () => {
    const server = new FakeServer();
    const originalFetch = server.fetch;
    let offline = false;
    let retries = 0;
    const api = new ApiClient({ baseUrl: 'http://srv', getToken: async () => 't0k', upload: server.upload, fetch: async (url, init) => {
      if (url.endsWith('/jobs/j1') && offline) throw new Error('offline');
      const response = await originalFetch(url, init);
      if (url.endsWith('/retry')) { retries++; offline = true; server.silently('j1', 'processing'); throw new Error('response lost'); }
      return response;
    } });
    const exec = new CloudExecutor({ api, adapter, pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] } });
    exec.addFiles([file('a')]);
    await exec.start();
    server.silently('j1', 'canceled');
    await exec.refetch();
    await expect(exec.retry(exec.snapshot[0]!.id, 'all')).rejects.toThrow('无法确认');
    expect(exec.snapshot[0]?.status).toBe('canceled');
    offline = false;
    await exec.retry(exec.snapshot[0]!.id, 'all');
    expect(exec.snapshot[0]?.status).toBe('processing');
    expect(retries).toBe(1);
    await exec.dispose();
  });

  it.each([true, false])('retry未确认期间processing SSE早到=%s时，真实状态可以离开旧canceled', async early => {
    const server = new FakeServer();
    const originalFetch = server.fetch;
    let offline = false;
    const api = new ApiClient({ baseUrl: 'http://srv', getToken: async () => 't0k', upload: server.upload, fetch: async (url, init) => {
      if (offline && url.endsWith('/jobs/j1')) throw new Error('offline');
      const response = await originalFetch(url, init);
      if (url.endsWith('/retry')) {
        offline = true;
        if (early) { server.push({ type: 'job', jobId: 'j1', status: 'processing', progress: 0.4 }); await tick(5); }
        throw new Error('retry response lost');
      }
      return response;
    } });
    const exec = new CloudExecutor({ api, adapter, pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] } });
    exec.addFiles([file('a')]);
    await exec.start();
    server.silently('j1', 'canceled');
    await exec.refetch();
    await expect(exec.retry(exec.snapshot[0]!.id, 'all')).rejects.toThrow('无法确认');
    if (!early) server.push({ type: 'job', jobId: 'j1', status: 'processing', progress: 0.4 });
    await tick(5);
    expect(exec.snapshot[0]?.status).toBe('processing');
    expect(exec.snapshot[0]?.progress).toBe(0.4);
    await exec.dispose();
  });
  it('adapter.read期间取消，读取完成后不上传或开始Provider处理', async () => {
    const server = new FakeServer();
    let readStarted = false;
    let release!: (bytes: Uint8Array) => void;
    const read = new Promise<Uint8Array>(resolve => { release = resolve; });
    const exec = new CloudExecutor({ api: new ApiClient({ baseUrl: 'http://srv', getToken: async () => 't0k', upload: server.upload, fetch: server.fetch }), adapter: { ...adapter, read: async () => { readStarted = true; return read; } }, pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] } });
    exec.addFiles([file('a')]);
    const run = exec.start();
    await until(() => readStarted);
    await exec.cancel(exec.snapshot[0]!.id);
    release(new Uint8Array(4));
    await run;
    expect(server.requests.filter(request => request.path.includes('(multipart)'))).toHaveLength(0);
    expect(server.requests.some(request => request.path.endsWith('/start'))).toBe(false);
    expect(exec.snapshot[0]?.status).toBe('canceled');
    await exec.dispose();
  });

  it.each(['file', 'url'] as const)('已取消%s晚返回job时，补偿cancel完成之前不能/start收费', async kind => {
    const server = new FakeServer();
    const originalFetch = server.fetch;
    let releaseUpload!: () => void;
    let releaseCancel!: () => void;
    let uploadStarted = false;
    let cancelStarted = false;
    const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
    const cancelGate = new Promise<void>(resolve => { releaseCancel = resolve; });
    const api = new ApiClient({ baseUrl: 'http://srv', getToken: async () => 't0k', upload: async request => {
      if (kind === 'file' && request.body.get('files') instanceof File && (request.body.get('files') as File).name === 'a.png') { uploadStarted = true; await uploadGate; }
      return server.upload(request);
    }, fetch: async (url, init) => {
      if (kind === 'url' && url.endsWith('/items')) { uploadStarted = true; await uploadGate; }
      if (url.endsWith('/cancel')) {
        cancelStarted = true;
        await cancelGate;
        const jobId = url.split('/').at(-2)!;
        server.silently(jobId, 'canceled');
      }
      return originalFetch(url, init);
    } });
    const exec = new CloudExecutor({ api, adapter, pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] } });
    if (kind === 'file') exec.addFiles([file('a')]); else exec.addUrls(['https://image.example/a.png']);
    exec.addFiles([file('other')]);
    const run = exec.start();
    await until(() => uploadStarted);
    await exec.cancel(exec.snapshot[0]!.id);
    releaseUpload();
    await until(() => cancelStarted);
    try {
      await tick(5);
      expect(server.requests.some(request => request.path.endsWith('/start'))).toBe(false);
    } finally { releaseCancel(); await run; await exec.dispose(); }
    expect(exec.snapshot[0]?.status).toBe('canceled');
    expect(exec.snapshot[1]?.status).toBe('queued');
    expect([...server.jobs.values()].filter(job => job.status === 'queued')).toHaveLength(1);
  });

  it('补偿cancel持续失败时/start计费请求为0，恢复后再次Start只启动未取消图片', async () => {
    const server = new FakeServer();
    const originalFetch = server.fetch;
    let failCancel = true;
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const api = new ApiClient({ baseUrl: 'http://srv', getToken: async () => 't0k', upload: async request => {
      if ((request.body.get('files') as File).name === 'a.png') { started = true; await gate; }
      return server.upload(request);
    }, fetch: async (url, init) => {
      if (url.endsWith('/cancel')) {
        if (failCancel) return json(503, { code: 'PROVIDER_UNAVAILABLE', message: 'offline', requestId: 'r', retryable: true });
        server.silently(url.split('/').at(-2)!, 'canceled');
      }
      return originalFetch(url, init);
    } });
    const exec = new CloudExecutor({ api, adapter, pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] } });
    exec.addFiles([file('a'), file('other')]);
    const run = exec.start();
    await until(() => started);
    await exec.cancel(exec.snapshot[0]!.id);
    release();
    await run;
    expect(server.requests.some(request => request.path.endsWith('/start'))).toBe(false);
    expect(exec.snapshot.map(item => item.status)).toEqual(['canceled', 'draft']);
    failCancel = false;
    await exec.start();
    expect(exec.snapshot.map(item => item.status)).toEqual(['canceled', 'queued']);
    expect([...server.jobs.values()].filter(job => job.status === 'queued')).toHaveLength(1);
    expect(server.jobs.size).toBe(2);
    await exec.dispose();
  });

  it('XHR取消未返回jobId但Server已留草稿时，GET确认并取消孤立草稿后再/start', async () => {
    const server = new FakeServer();
    const originalFetch = server.fetch;
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const api = new ApiClient({ baseUrl: 'http://srv', getToken: async () => 't0k', upload: async request => {
      if ((request.body.get('files') as File).name === 'a.png') {
        started = true;
        await gate;
        await server.upload(request);
        throw new DOMException('aborted', 'AbortError');
      }
      return server.upload(request);
    }, fetch: async (url, init) => {
      if (url.endsWith('/cancel')) server.silently(url.split('/').at(-2)!, 'canceled');
      return originalFetch(url, init);
    } });
    const exec = new CloudExecutor({ api, adapter, pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] } });
    exec.addFiles([file('a'), file('other')]);
    const run = exec.start();
    await until(() => started);
    await exec.cancel(exec.snapshot[0]!.id);
    release();
    await run;
    const get = server.requests.findIndex(request => request.path === '/batches/b1' && request.method === 'GET');
    const cancel = server.requests.findIndex(request => request.path.endsWith('/cancel'));
    const start = server.requests.findIndex(request => request.path.endsWith('/start'));
    expect(get).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(get);
    expect(start).toBeGreaterThan(cancel);
    expect([...server.jobs.values()].filter(job => job.status === 'queued')).toHaveLength(1);
    await exec.dispose();
  });
  it('/start 未到达Server时按远端draft恢复，再次开始复用已上传图片', async () => {
    const server = new FakeServer();
    const originalFetch = server.fetch;
    let starts = 0;
    const api = new ApiClient({ baseUrl: 'http://srv', getToken: async () => 't0k', upload: server.upload, fetch: async (url, init) => {
      if (url.endsWith('/start') && ++starts === 1) throw new Error('start offline');
      return originalFetch(url, init);
    } });
    const exec = new CloudExecutor({ api, adapter, pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] } });
    exec.addFiles([file('a')]);
    await exec.start();
    expect(exec.snapshot[0]?.status).toBe('draft');
    expect(exec.snapshot[0]?.error?.message).toContain('请再次点击开始处理');
    expect(server.requests.some(request => request.path === '/batches/b1' && request.method === 'GET')).toBe(true);
    await exec.start();
    expect(starts).toBe(2);
    expect(server.jobs.size).toBe(1);
    expect(server.requests.filter(request => request.path.includes('(multipart)'))).toHaveLength(1);
    expect(server.requests.some(request => request.path.endsWith('/retry'))).toBe(false);
    expect(exec.snapshot[0]?.status).toBe('queued');
    await exec.dispose();
  });

  it.each(['processing', 'completed'] as const)('/start 响应丢失但Server已%s时校正实态，不重新启动或上传', async status => {
    const server = new FakeServer();
    const originalFetch = server.fetch;
    const api = new ApiClient({ baseUrl: 'http://srv', getToken: async () => 't0k', upload: server.upload, fetch: async (url, init) => {
      if (url.endsWith('/start')) {
        await originalFetch(url, init);
        server.silently('j1', status, status === 'completed' ? [{ outputId: 'j1-o', destination: { type: 'download' }, status: 'completed' }] : undefined);
        throw new Error('response lost');
      }
      return originalFetch(url, init);
    } });
    const exec = new CloudExecutor({ api, adapter, pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] } });
    exec.addFiles([file('a')]);
    await exec.start();
    expect(exec.snapshot[0]?.status).toBe(status);
    if (status === 'completed') expect(exec.snapshot[0]?.output?.size).toBe(2);
    await exec.start();
    expect(server.requests.filter(request => request.path.endsWith('/start'))).toHaveLength(1);
    expect(server.jobs.size).toBe(1);
    await exec.dispose();
  });

  it.each(['completed', 'failed'] as const)('取消与Server %s竞争且无额外SSE时，cancel响应后按Job校正终态', async status => {
    const server = new FakeServer();
    const originalFetch = server.fetch;
    const api = new ApiClient({ baseUrl: 'http://srv', getToken: async () => 't0k', upload: server.upload, fetch: async (url, init) => {
      if (url.endsWith('/cancel')) server.silently('j1', status);
      return originalFetch(url, init);
    } });
    const exec = new CloudExecutor({ api, adapter, pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] } });
    exec.addFiles([file('a')]);
    await exec.start();
    await exec.cancel(exec.snapshot[0]!.id);
    expect(exec.snapshot[0]?.status).toBe(status);
    expect(server.requests.some(request => request.path === '/jobs/j1' && request.method === 'GET')).toBe(true);
    await exec.dispose();
  });

  it('URL添加期间取消中断请求，晚失败不能把canceled改成failed', async () => {
    const server = new FakeServer();
    const originalFetch = server.fetch;
    let started = false;
    let requestSignal: AbortSignal | undefined;
    let fail!: (reason: Error) => void;
    const api = new ApiClient({ baseUrl: 'http://srv', getToken: async () => 't0k', upload: server.upload, fetch: async (url, init) => {
      if (url.endsWith('/items') && init?.method === 'POST') {
        started = true;
        requestSignal = init.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => { fail = reject; });
      }
      return originalFetch(url, init);
    } });
    const exec = new CloudExecutor({ api, adapter, pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] } });
    exec.addUrls(['https://images.example/a.png']);
    const run = exec.start();
    await until(() => started);
    await exec.cancel(exec.snapshot[0]!.id);
    expect(requestSignal?.aborted).toBe(true);
    fail(new Error('late network failure'));
    await run;
    expect(exec.snapshot[0]?.status).toBe('canceled');
    expect(exec.snapshot[0]?.error).toBeUndefined();
    expect(server.requests.some(request => request.path.endsWith('/start'))).toBe(false);
    await exec.dispose();
  });

  it('/start与校正GET都断网后，恢复连接的重试先拉批次，不误走Provider retry', async () => {
    const server = new FakeServer();
    const originalFetch = server.fetch;
    let offline = true;
    const api = new ApiClient({ baseUrl: 'http://srv', getToken: async () => 't0k', upload: server.upload, fetch: async (url, init) => {
      if (offline && (url.endsWith('/start') || (url.endsWith('/batches/b1') && (!init?.method || init.method === 'GET')))) throw new Error('offline');
      return originalFetch(url, init);
    } });
    const exec = new CloudExecutor({ api, adapter, pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] } });
    exec.addFiles([file('a')]);
    await exec.start();
    expect(exec.snapshot[0]?.status).toBe('failed');
    expect(exec.snapshot[0]?.error?.message).toContain('无法确认');
    offline = false;
    await exec.retry(exec.snapshot[0]!.id, 'all');
    expect(exec.snapshot[0]?.status).toBe('draft');
    await exec.start();
    expect(exec.snapshot[0]?.status).toBe('queued');
    expect(server.jobs.size).toBe(1);
    expect(server.requests.some(request => request.path.endsWith('/retry'))).toBe(false);
    await exec.dispose();
  });

  it('多个URL共享5个上传并发，取消一张不影响其他URL', async () => {
    const server = new FakeServer();
    const originalFetch = server.fetch;
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const api = new ApiClient({ baseUrl: 'http://srv', getToken: async () => 't0k', upload: server.upload, fetch: async (url, init) => {
      if (url.endsWith('/items') && init?.method === 'POST') {
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
        if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      }
      return originalFetch(url, init);
    } });
    const exec = new CloudExecutor({ api, adapter, pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] } });
    exec.addUrls(Array.from({ length: 9 }, (_, index) => 'https://images.example/' + index + '.png'));
    const run = exec.start();
    try {
      await until(() => active > 0);
      await tick(3);
      expect(peak).toBe(5);
      await exec.cancel(exec.snapshot[0]!.id);
    } finally {
      release();
      await run;
      await exec.dispose();
    }
    expect(exec.snapshot[0]?.status).toBe('canceled');
    expect(exec.snapshot.slice(1).every(item => item.status === 'queued')).toBe(true);
    expect(server.jobs.size).toBe(8);
  });

  it('连续开始不重复创建批次，开始期间新加的图片保持草稿', async () => {
    const { server, exec } = setup();
    exec.addFiles([file('a')]);
    const first = exec.start();
    exec.addFiles([file('b')]);
    const second = exec.start();
    await Promise.all([first, second]);
    expect(server.requests.filter(r => r.path === '/batches')).toHaveLength(1);
    expect(server.jobs.size).toBe(2);
    expect(exec.snapshot.map(i => i.status)).toEqual(['queued', 'queued']);
    await exec.dispose();
  });

  it('云端终态不被迟到的 processing 事件覆盖', async () => {
    const { server, exec } = setup();
    exec.addFiles([file('a')]);
    await exec.start();
    await until(() => server.streams.length === 1);
    server.push({ type: 'job', jobId: 'j1', status: 'completed' });
    await until(() => exec.snapshot[0]?.status === 'completed');
    server.push({ type: 'job', jobId: 'j1', status: 'processing', progress: 0.2 });
    await tick(10);
    expect(exec.snapshot[0]?.status).toBe('completed');
    expect(exec.snapshot[0]?.progress).toBe(1);
    await exec.dispose();
  });

  it('本次上传失败后再次点击开始可以重试上传，不重复处理成功任务', async () => {
    const server = new FakeServer();
    let uploads = 0;
    const exec = new CloudExecutor({ api: new ApiClient({ baseUrl: 'http://srv', getToken: async () => 't0k', fetch: server.fetch, upload: async request => {
      if (++uploads === 1) throw new Error('upload offline');
      return server.upload(request);
    } }), adapter, pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] } });
    exec.addFiles([file('a')]);
    await exec.start();
    expect(exec.snapshot[0]?.status).toBe('failed');
    await exec.retry(exec.snapshot[0]!.id, 'all');
    expect(exec.snapshot[0]?.status).toBe('draft');
    await exec.start();
    expect(server.jobs.size).toBe(1);
    expect(exec.snapshot[0]?.status).toBe('queued');
    await exec.dispose();
  });
  it('重试的完成事件先于HTTP响应抵达时，不回退为queued', async () => {
    const server = new FakeServer();
    const originalFetch = server.fetch;
    const api = new ApiClient({ baseUrl: 'http://srv', getToken: async () => 't0k', upload: server.upload, fetch: async (url, init) => {
      const response = await originalFetch(url, init);
      if (url.endsWith('/retry')) {
        server.push({ type: 'job', jobId: 'j1', status: 'completed', outputs: [{ outputId: 'j1-o', destination: { type: 'download' }, status: 'completed' }] });
        await tick(10);
      }
      return response;
    } });
    const exec = new CloudExecutor({ api, adapter, pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] } });
    exec.addFiles([file('a')]);
    await exec.start();
    await until(() => server.streams.length === 1);
    server.push({ type: 'job', jobId: 'j1', status: 'failed', error: { code: 'PROVIDER_ERROR', message: 'retry', retryable: true, requestId: 'r' } });
    await until(() => exec.snapshot[0]?.status === 'failed');
    await exec.retry(exec.snapshot[0]!.id, 'all');
    expect(exec.snapshot[0]?.status).toBe('completed');
    await exec.dispose();
  });

  it('取消请求失败向调用者报告错误，任务保持可取消，不能永久显示取消中', async () => {
    const server = new FakeServer();
    const originalFetch = server.fetch;
    const api = new ApiClient({ baseUrl: 'http://srv', getToken: async () => 't0k', upload: server.upload, fetch: async (url, init) => {
      if (url.endsWith('/cancel')) return json(503, { code: 'PROVIDER_UNAVAILABLE', message: 'network offline', retryable: true, requestId: 'r' });
      return originalFetch(url, init);
    } });
    const exec = new CloudExecutor({ api, adapter, pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] } });
    exec.addFiles([file('a')]);
    await exec.start();
    const cancel = exec.cancel(exec.snapshot[0]!.id);
    expect(cancel).toBeInstanceOf(Promise);
    if (cancel) await expect(cancel).rejects.toThrow('network offline');
    expect(exec.snapshot[0]?.status).toBe('queued');
    await exec.dispose();
  });

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
