import sharp from 'sharp';
import type { ImageProviderManifest, Operation, ProviderId, ProviderUsageResponse } from '@tinypng/shared';
import { AccountPool, type AccountPublic } from '../accounts';
import type { ServerConfig } from '../config';
import { AppError } from '../errors';
import { UsageTracker, type AccountReservation } from '../usage';
import { header, httpsTransport, type ProviderRequest, type ProviderResponse, type ProviderTransport } from './transport';

const OFFICIAL = 'https://api.tinify.com';
const ANONYMOUS_SITES = ['https://tinypng.com', 'https://tinyjpg.com', 'https://tinify.cn'] as const;
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif' } as const;
const CAPABILITIES = { compress: true, smartResize: false, crop: false, smartCrop: false, metadata: [], urlInput: true, storageOutput: false };
export const OFFICIAL_MANIFEST: ImageProviderManifest = { id: 'official-tinify', label: '官方 Tinify', processing: 'cloud', capabilities: { ...CAPABILITIES, convert: ['png', 'jpeg', 'webp', 'avif'], resize: true } };
export const ANONYMOUS_MANIFEST: ImageProviderManifest = { id: 'anonymous-tinify', label: '匿名 Tinify', processing: 'cloud', capabilities: { ...CAPABILITIES, convert: [], resize: false } };

export interface ProviderExecution {
  providerId: ProviderId; operations: Operation[]; data: Uint8Array; mimeType: string; signal: AbortSignal;
}
export interface ProviderResult { data: Uint8Array; mimeType: string; width: number; height: number; accountId?: string }
export interface ProviderService {
  list(): ImageProviderManifest[];
  execute(input: ProviderExecution): Promise<ProviderResult>;
  usage(providerId: string): ProviderUsageResponse;
  refreshUsage(providerId: string): Promise<ProviderUsageResponse>;
  close(): void;
}
export interface ProviderAudit {
  providerId: string; accountId?: string; attempt: number; rotations: number; httpStatus: number;
}
export interface ProviderOptions {
  accounts?: AccountPool;
  transport?: ProviderTransport;
  now?: () => number;
  refreshOnStart?: boolean;
  audit?: (record: ProviderAudit) => void;
  retryDelayMs?: number;
}

//#region Provider 入口、刷新与安全传输
export class TinifyProviderService implements ProviderService {
  private readonly accounts: AccountPool;
  private readonly tracker: UsageTracker;
  private readonly transport: ProviderTransport;
  private readonly startup: Promise<void>;
  private readonly refreshTimer: ReturnType<typeof setInterval>;
  private readonly monthTimer: ReturnType<typeof setInterval>;
  private readonly shutdown = new AbortController();
  private anonymousIndex = 0;

  constructor(private readonly config: ServerConfig, private readonly options: ProviderOptions = {}) {
    this.accounts = options.accounts ?? AccountPool.load();
    this.tracker = new UsageTracker(this.accounts, options.now);
    this.transport = options.transport ?? httpsTransport;
    this.startup = options.refreshOnStart === false ? Promise.resolve() : this.refreshAccounts(false);
    this.refreshTimer = setInterval(() => { void this.refreshAccounts(false); }, 30 * 60_000);
    this.monthTimer = setInterval(() => this.checkMonth(), 60_000);
    this.refreshTimer.unref(); this.monthTimer.unref();
  }

  ready(): Promise<void> { return this.startup; }
  list(): ImageProviderManifest[] { return [structuredClone(ANONYMOUS_MANIFEST), structuredClone(OFFICIAL_MANIFEST)]; }
  close(): void { clearInterval(this.refreshTimer); clearInterval(this.monthTimer); this.shutdown.abort(); }
  private checkMonth(): void {
    if (this.tracker.resetMonthIfNeeded() && !this.shutdown.signal.aborted) void this.refreshAccounts(false);
  }
  usage(providerId: string): ProviderUsageResponse {
    this.requireProvider(providerId);
    this.checkMonth();
    return providerId === 'official-tinify' ? this.tracker.snapshot() : { providerId, accounts: [] };
  }
  async refreshUsage(providerId: string): Promise<ProviderUsageResponse> {
    this.requireProvider(providerId);
    if (providerId === 'official-tinify') { await this.ready(); await this.refreshAccounts(true); }
    return this.usage(providerId);
  }
  private requireProvider(id: string): void {
    if (id !== 'official-tinify' && id !== 'anonymous-tinify') throw new AppError('PROVIDER_UNAVAILABLE', '所选处理线路不可用', { providerId: id });
  }

  private async refreshAccounts(manual: boolean): Promise<void> {
    const list = this.tracker.accountsForRefresh(manual);
    await Promise.all(list.map(async account => {
      try {
        // 与官方 SDK validate 一致：空 POST /shrink；400 和 429 只验证连接、认证及计数，不会消费额度。
        await this.officialRequest(account, { url: OFFICIAL + '/shrink', method: 'POST', headers: {}, signal: this.shutdown.signal });
      } catch { /* 失败已标记 unknown/冷却，启动与定时任务不向外抛上游敏感信息。 */ }
    }));
  }

  private async request(input: ProviderRequest): Promise<ProviderResponse> {
    if (input.signal.aborted) throw input.signal.reason ?? new Error('canceled');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new AppError('PROVIDER_TIMEOUT', '图片服务响应超时，请稍后重试', { retryable: true })), Math.min(60_000, this.config.providerTimeoutMs));
    const cancel = () => controller.abort(input.signal.reason ?? new Error('canceled'));
    const shutdown = () => controller.abort(new Error('provider closed'));
    input.signal.addEventListener('abort', cancel, { once: true });
    this.shutdown.signal.addEventListener('abort', shutdown, { once: true });
    try {
      return await new Promise<ProviderResponse>((resolve, reject) => {
        const aborted = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', aborted, { once: true });
        this.transport({ ...input, signal: controller.signal }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', aborted));
      });
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof AppError) throw error;
      throw new AppError('PROVIDER_ERROR', '暂时无法连接图片服务，请稍后重试', { retryable: true });
    } finally {
      clearTimeout(timeout); input.signal.removeEventListener('abort', cancel); this.shutdown.signal.removeEventListener('abort', shutdown);
    }
  }

  private async officialRequest(account: AccountPublic, input: ProviderRequest): Promise<ProviderResponse> {
    this.officialUrl(input.url);
    const requestMonth = new Date(this.options.now?.() ?? Date.now()).toISOString().slice(0, 7);
    try {
      const response = await this.request({ ...input, headers: { ...input.headers, Authorization: 'Basic ' + Buffer.from('api:' + this.accounts.keyOf(account)).toString('base64') } });
      this.checkMonth();
      this.tracker.observe(account, header(response, 'Compression-Count'), response.status, requestMonth);
      this.options.audit?.({ providerId: 'official-tinify', accountId: account.accountId, attempt: 0, rotations: 0, httpStatus: response.status });
      return response;
    } catch (error) {
      this.checkMonth();
      this.tracker.observe(account, undefined, 0, requestMonth);
      this.options.audit?.({ providerId: 'official-tinify', accountId: account.accountId, attempt: 0, rotations: 0, httpStatus: 0 });
      throw error;
    }
  }

  private officialUrl(raw: string): string {
    let url: URL;
    try { url = new URL(raw); } catch { throw this.upstreamError(); }
    if (url.origin !== OFFICIAL || url.username || url.password || url.hash || (url.pathname !== '/shrink' && !/^\/output\/[a-zA-Z0-9_-]+$/.test(url.pathname))) throw this.upstreamError();
    return url.toString();
  }
  private upstreamError(): AppError { return new AppError('PROVIDER_ERROR', '图片服务返回了无效结果，请重试', { retryable: true }); }
  private ensureSuccess(response: ProviderResponse, providerId: string): void {
    if (response.status >= 200 && response.status < 300) return;
    if (providerId === 'anonymous-tinify') throw new AppError(
      response.status === 401 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR',
      '匿名线路暂时不可用，请稍后重试或手动选择官方线路',
      { providerId, retryable: response.status === 429 || response.status >= 500 },
    );
    if (providerId === 'official-tinify' && response.status === 429) throw new AppError('QUOTA_EXHAUSTED', '官方账号达到额度或请求限制，请刷新后重试', { providerId, retryable: true });
    if (response.status === 401) throw new AppError('PROVIDER_UNAVAILABLE', '官方账号暂不可用，请检查账号配置', { providerId });
    throw new AppError('PROVIDER_ERROR', '图片服务处理失败，请稍后重试', { providerId, retryable: response.status === 429 || response.status >= 500 });
  }
  private async decode(data: Uint8Array, expectedMime?: string): Promise<ProviderResult> {
    try {
      const meta = await sharp(data, { limitInputPixels: 100_000_000, failOn: 'error' }).metadata();
      // libvips 把 AVIF 标为 heif 容器，只接受 AV1 编码，不能把 HEIC 混报成 AVIF。
      const mimeType = meta.format === 'heif' && meta.compression === 'av1' ? MIME.avif : MIME[meta.format as keyof typeof MIME];
      if (!mimeType || !meta.width || !meta.height || (expectedMime && expectedMime.split(';')[0]?.trim() !== mimeType)) throw this.upstreamError();
      // metadata 只解析文件头；stats 强制读取像素，截断的 IDAT/JPEG 不能被报告为成功结果。
      await sharp(data, { limitInputPixels: 100_000_000, failOn: 'error' }).stats();
      return { data, mimeType, width: meta.width, height: meta.height };
    } catch { throw this.upstreamError(); }
  }

  async execute(input: ProviderExecution): Promise<ProviderResult> {
    this.requireProvider(input.providerId);
    if (this.shutdown.signal.aborted) throw new AppError('PROVIDER_UNAVAILABLE', '图片服务已关闭');
    if (input.providerId === 'anonymous-tinify' && !this.config.anonymousTinify.enabled) throw new AppError('ANONYMOUS_DISABLED', '匿名线路暂时关闭，请选择其他线路', { providerId: input.providerId });
    for (const op of input.operations) {
      const supported = op.type === 'compress' || (input.providerId === 'official-tinify' && (op.type === 'convert' || op.type === 'resize'));
      if (!supported) throw new AppError('OPERATION_UNSUPPORTED', '所选线路不支持该操作，请使用官方线路', { providerId: input.providerId, suggestProviderId: 'official-tinify' });
      if (op.type === 'resize' && ((!op.width && !op.height) || [op.width, op.height].some(value => value !== undefined && (!Number.isInteger(value) || value < 1 || value > 16384)))) throw new AppError('VALIDATION_FAILED', '缩放尺寸需要在 1 到 16384 之间');
    }
    if (input.signal.aborted) throw input.signal.reason ?? new Error('canceled');
    const decoded = await this.decode(input.data, input.mimeType);
    if (input.providerId === 'anonymous-tinify') return this.anonymous(input, decoded);
    await this.ready(); this.checkMonth();
    const reservation = this.tracker.reserve(this.cost(input.operations));
    try { return { ...await this.official(input, decoded, reservation), accountId: reservation.account.accountId }; }
    finally { reservation.release(); }
  }
//#endregion

//#region 官方逐步操作链与完整预算预留
  private cost(operations: Operation[]): number {
    let cost = 0, source = false;
    for (const op of operations) {
      if (op.type === 'compress') { cost++; source = true; }
      else if (op.type === 'convert' || (op.type === 'resize' && op.fit !== 'cover')) { cost += (source ? 0 : 1) + 1; source = false; }
      else if (op.type === 'resize') { cost++; source = true; }
    }
    return Math.max(1, cost);
  }

  private async official(input: ProviderExecution, initial: ProviderResult, reservation: AccountReservation): Promise<ProviderResult> {
    const account = reservation.account;
    let current = initial;
    let source: string | undefined;
    const paidRequest = async (request: ProviderRequest) => {
      const settled = reservation.beginCharge();
      try { return await this.officialRequest(account, request); }
      finally { settled(); }
    };
    const upload = async () => {
      const response = await paidRequest({ url: OFFICIAL + '/shrink', method: 'POST', headers: { 'Content-Type': current.mimeType }, body: current.data, signal: input.signal });
      this.ensureSuccess(response, input.providerId);
      const location = header(response, 'Location');
      if (!location) throw this.upstreamError();
      source = this.officialUrl(location);
    };
    const download = async (options?: Record<string, unknown>) => {
      if (!source) await upload();
      const request: ProviderRequest = { url: source!, method: options ? 'POST' : 'GET', headers: options ? { 'Content-Type': 'application/json' } : {}, body: options ? Buffer.from(JSON.stringify(options)) : undefined, signal: input.signal };
      const response = options ? await paidRequest(request) : await this.officialRequest(account, request);
      this.ensureSuccess(response, input.providerId);
      current = await this.decode(response.body, header(response, 'Content-Type'));
    };

    for (const op of input.operations) {
      if (input.signal.aborted) throw input.signal.reason ?? new Error('canceled');
      if (op.type === 'compress') { source = undefined; await upload(); await download(); }
      else if (op.type === 'convert') {
        await download({ convert: { type: MIME[op.format] }, ...(op.format === 'jpeg' ? { transform: { background: '#ffffff' } } : {}) });
        source = undefined;
      } else if (op.type === 'resize' && op.fit !== 'cover') {
        if ((op.width ?? current.width) * (op.height ?? current.height) > 100_000_000) throw new AppError('VALIDATION_FAILED', '缩放后的图片像素数量过大');
        const size = op.width && op.height ? { method: 'fit', width: op.width, height: op.height } : { method: 'scale', ...(op.width ? { width: op.width } : { height: op.height }) };
        await download({ resize: size }); source = undefined;
        if (op.fit === 'contain' && op.width && op.height) {
          if (current.width > op.width || current.height > op.height) throw this.upstreamError();
          // Tinify fit 保持小图不放大；sharp 仅补固定画布的居中留白，不再重复收费压缩。
          const horizontal = op.width - current.width, vertical = op.height - current.height;
          const padded = await sharp(current.data).extend({
            left: Math.floor(horizontal / 2), right: Math.ceil(horizontal / 2),
            top: Math.floor(vertical / 2), bottom: Math.ceil(vertical / 2),
            background: current.mimeType === 'image/jpeg' ? '#ffffff' : { r: 0, g: 0, b: 0, alpha: 0 },
          }).toBuffer();
          current = await this.decode(padded);
        }
      } else if (op.type === 'resize') {
        if ((op.width ?? current.width) * (op.height ?? current.height) > 100_000_000) throw new AppError('VALIDATION_FAILED', '缩放后的图片像素数量过大');
        const resized = await sharp(current.data, { limitInputPixels: 100_000_000 }).resize({ width: op.width, height: op.height, fit: op.width && op.height ? op.fit : 'inside', position: 'centre', background: current.mimeType === 'image/jpeg' ? '#ffffff' : { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
        current = await this.decode(resized); source = undefined;
        // cover 的中心裁切由 sharp 保证，然后交官方引擎重新压缩。
        await upload(); await download();
      }
    }
    if (!input.operations.length) { await upload(); await download(); }
    return current;
  }
//#endregion

//#region 匿名网站线路、有限轮换与审计
  private anonymousUrl(raw: string): string {
    let url: URL;
    try { url = new URL(raw); } catch { throw this.upstreamError(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !ANONYMOUS_SITES.some(site => new URL(site).hostname === url.hostname) || !/^\/(?:web\/)?output\//.test(url.pathname)) throw this.upstreamError();
    return url.toString();
  }

  private async anonymous(input: ProviderExecution, initial: ProviderResult): Promise<ProviderResult> {
    let current = initial;
    // 每个 compress 保持操作链顺序；同一阶段最多初次加 2 次重试。
    for (let step = 0; step < Math.max(1, input.operations.length); step++) {
      const retries = Math.min(2, this.config.maxRetries);
      for (let attempt = 0; ; attempt++) {
        if (input.signal.aborted) throw input.signal.reason ?? new Error('canceled');
        const site = ANONYMOUS_SITES[this.anonymousIndex++ % ANONYMOUS_SITES.length]!;
        let responded = false;
        try {
          const upload = await this.request({ url: site + '/backend/opt/shrink', method: 'POST', headers: { 'Content-Type': current.mimeType }, body: current.data, signal: input.signal });
          responded = true;
          this.options.audit?.({ providerId: input.providerId, attempt, rotations: attempt, httpStatus: upload.status });
          this.ensureSuccess(upload, input.providerId);
          let outputUrl: string;
          try { outputUrl = this.anonymousUrl(JSON.parse(Buffer.from(upload.body).toString('utf8')).output.url); }
          catch { throw this.upstreamError(); }
          responded = false;
          const response = await this.request({ url: outputUrl, method: 'GET', headers: {}, signal: input.signal });
          responded = true;
          this.options.audit?.({ providerId: input.providerId, attempt, rotations: attempt, httpStatus: response.status });
          this.ensureSuccess(response, input.providerId);
          current = await this.decode(response.body, header(response, 'Content-Type'));
          break;
        } catch (error) {
          if (!responded) this.options.audit?.({ providerId: input.providerId, attempt, rotations: attempt, httpStatus: 0 });
          if (input.signal.aborted || this.shutdown.signal.aborted) throw error;
          if (error instanceof AppError && (!error.opts.retryable || attempt >= retries)) throw error;
          if (attempt >= retries) throw this.upstreamError();
          await this.retryWait(input.signal);
        }
      }
    }
    return { ...current, accountId: 'anonymous' };
  }

  private retryWait(signal: AbortSignal): Promise<void> {
    const delay = this.options.retryDelayMs ?? 250;
    if (!delay) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', canceled); resolve(); }, delay);
      const canceled = () => { clearTimeout(timer); signal.removeEventListener('abort', canceled); reject(signal.reason ?? new Error('canceled')); };
      signal.addEventListener('abort', canceled, { once: true });
      if (signal.aborted) canceled();
    });
  }
//#endregion
}

export function createProviderService(config: ServerConfig, options: ProviderOptions = {}): TinifyProviderService {
  return new TinifyProviderService(config, options);
}
