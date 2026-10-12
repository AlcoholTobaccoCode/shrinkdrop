import { isApiError, type ApiError, type Batch, type CreateBatchRequest, type ImageProviderManifest, type Job, type ProviderId, type ProviderUsageResponse } from '@tinypng/shared';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface UploadRequest {
  url: string;
  headers: Record<string, string>;
  body: FormData;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
}
export interface UploadResponse { status: number; body: string }
/** 上传用 XHR（fetch 拿不到上传进度）；测试里注入假实现 */
export type Uploader = (req: UploadRequest) => Promise<UploadResponse>;

export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly error: ApiError) {
    super(error.message);
    this.name = 'ApiRequestError';
  }
}

export interface ApiClientOptions {
  /** 例如 http://127.0.0.1:8787，不带 /api/v1 */
  baseUrl: string;
  getToken: () => Promise<string | undefined>;
  fetch?: FetchLike;
  upload?: Uploader;
}

/** POST /items 返回体：v0.2 未写明，按 { jobs: Job[] }（与上传顺序一致）实现，待无敌王八确认 */
export interface AddItemsResponse { jobs: Job[] }

export class ApiClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly uploader: Uploader;

  constructor(private readonly options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '') + '/api/v1';
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.uploader = options.upload ?? xhrUpload;
  }

  async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await this.options.getToken();
    return token ? { ...extra, Authorization: 'Bearer ' + token } : extra;
  }

  url(path: string): string {
    return this.baseUrl + path;
  }

  async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = await this.headers((init.headers as Record<string, string>) ?? {});
    const res = await this.fetchImpl(this.url(path), { ...init, headers });
    if (!res.ok) throw await toError(res.status, await res.text());
    return res;
  }

  private async json<T>(path: string, init: RequestInit = {}, body?: unknown): Promise<T> {
    const res = await this.raw(path, body === undefined ? init : {
      ...init,
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...((init.headers as Record<string, string>) ?? {}) }
    });
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  providers(): Promise<ImageProviderManifest[]> { return this.json('/providers'); }
  usage(id: ProviderId): Promise<ProviderUsageResponse> { return this.json('/providers/' + encodeURIComponent(id) + '/usage'); }
  createBatch(req: CreateBatchRequest): Promise<{ batchId: string; status: 'draft' }> { return this.json('/batches', { method: 'POST' }, req); }
  getBatch(batchId: string): Promise<Batch> { return this.json('/batches/' + batchId); }
  getJob(jobId: string): Promise<Job> { return this.json('/jobs/' + jobId); }
  addUrls(batchId: string, urls: readonly string[]): Promise<AddItemsResponse> { return this.json('/batches/' + batchId + '/items', { method: 'POST' }, { urls }); }
  async deleteItem(batchId: string, jobId: string): Promise<void> { await this.raw('/batches/' + batchId + '/items/' + jobId, { method: 'DELETE' }); }
  async start(batchId: string): Promise<void> { await this.raw('/batches/' + batchId + '/start', { method: 'POST' }); }
  async cancelJob(jobId: string): Promise<void> { await this.raw('/jobs/' + jobId + '/cancel', { method: 'POST' }); }
  async cancelBatch(batchId: string): Promise<void> { await this.raw('/batches/' + batchId + '/cancel', { method: 'POST' }); }
  async retry(jobId: string, scope: 'all' | 'outputs'): Promise<void> { await this.json('/jobs/' + jobId + '/retry', { method: 'POST' }, { scope }); }
  async result(jobId: string): Promise<Blob> { return (await this.raw('/jobs/' + jobId + '/result')).blob(); }
  async archive(batchId: string): Promise<Blob> { return (await this.raw('/batches/' + batchId + '/archive')).blob(); }

  /** multipart 上传单个文件，带上传进度 */
  async uploadFile(batchId: string, file: Blob, filename: string, onProgress?: (ratio: number) => void, signal?: AbortSignal): Promise<AddItemsResponse> {
    const body = new FormData();
    body.append('files', file, filename);
    const res = await this.uploader({
      url: this.url('/batches/' + batchId + '/items'),
      headers: await this.headers(),
      body,
      signal,
      onProgress: (loaded, total) => onProgress?.(total > 0 ? loaded / total : 0)
    });
    if (res.status < 200 || res.status >= 300) throw await toError(res.status, res.body);
    return JSON.parse(res.body) as AddItemsResponse;
  }

  /** SSE 流（fetch 读，能带 Bearer） */
  events(batchId: string, signal: AbortSignal): Promise<Response> {
    return this.raw('/batches/' + batchId + '/events', { headers: { Accept: 'text/event-stream' }, signal });
  }
}

async function toError(status: number, text: string): Promise<ApiRequestError> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (isApiError(parsed)) return new ApiRequestError(status, parsed);
  return new ApiRequestError(status, {
    code: status === 401 ? 'AUTH_INVALID' : 'INTERNAL_ERROR',
    message: text || 'HTTP ' + String(status),
    retryable: status >= 500,
    requestId: ''
  });
}

export const xhrUpload: Uploader = req => new Promise((resolve, reject) => {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', req.url);
  for (const [k, v] of Object.entries(req.headers)) xhr.setRequestHeader(k, v);
  xhr.upload.onprogress = e => req.onProgress?.(e.loaded, e.lengthComputable ? e.total : 0);
  xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
  xhr.onerror = () => reject(new Error('上传失败，网络错误'));
  xhr.onabort = () => reject(new DOMException('上传已取消', 'AbortError'));
  req.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
  xhr.send(req.body);
});
