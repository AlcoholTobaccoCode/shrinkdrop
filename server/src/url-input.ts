import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { LIMITS } from '@tinypng/shared';
import { AppError } from './errors';
import { inspectImage } from './validation';
//#region URL安全边界
export type ResolvedAddress = {
    address: string;
    family: number;
};
export type UrlResponse = {
    status: number;
    headers: Record<string, string | undefined>;
    data: Uint8Array;
};
export type UrlTransport = (url: URL, address: ResolvedAddress, signal: AbortSignal, maxBytes: number) => Promise<UrlResponse>;
export interface UrlFetchOptions {
    maxBytes?: number;
    timeoutMs?: number;
    resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
    transport?: UrlTransport;
}
export function parsePublicUrl(raw: string): URL {
    let url: URL;
    try {
        url = new URL(raw);
    }
    catch {
        throw new AppError('URL_FORBIDDEN', '图片网址格式无效');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname)
        throw new AppError('URL_FORBIDDEN', '仅支持公开的HTTP或HTTPS图片网址');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (hostname.includes('%') || hostname.toLowerCase() === 'localhost' || isIP(hostname) && isForbiddenAddress(hostname))
        throw new AppError('URL_FORBIDDEN', '不能访问本机或内部网络地址');
    return url;
}
function ipv6Number(raw: string): bigint | undefined {
    let ip = raw.toLowerCase();
    if (ip.includes('.')) {
        const pos = ip.lastIndexOf(':');
        const bytes = ip.slice(pos + 1).split('.').map(Number);
        if (bytes.length !== 4)
            return;
        ip = ip.slice(0, pos + 1) + ((bytes[0]! << 8) | bytes[1]!).toString(16) + ':' + ((bytes[2]! << 8) | bytes[3]!).toString(16);
    }
    const halves = ip.split('::');
    if (halves.length > 2)
        return;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    if (groups.length !== 8 || groups.some(x => !/^([0-9a-f]{1,4})$/.test(x)))
        return;
    return groups.reduce((n, x) => (n << 16n) | BigInt(parseInt(x, 16)), 0n);
}
export function isForbiddenAddress(raw: string): boolean {
    const ip = raw.replace(/^\[|\]$/g, '');
    const version = isIP(ip);
    if (version === 4) {
        const [a, b, c] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || a! >= 224 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168 || a === 100 && b! >= 64 && b! <= 127 || a === 192 && b === 0 && c === 0 || a === 198 && (b === 18 || b === 19);
    }
    if (version === 6) {
        const n = ipv6Number(ip);
        if (n === undefined)
            return true;
        if (n >> 32n === 0xffffn) {
            const v = Number(n & 0xffffffffn);
            return isForbiddenAddress(`${v >>> 24}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`);
        }
        // 只接受可公网路由的全局单播；排除IPv6特殊用途及6to4内嵌地址。
        return n >> 125n !== 1n || n >> 112n === 0x2002n || n >> 105n === 0x100080n;
    }
    return true;
}
export async function resolvePublicAddress(url: URL, resolve: NonNullable<UrlFetchOptions['resolve']> = async (hostname) => lookup(hostname, { all: true, verbatim: true })): Promise<ResolvedAddress> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: ResolvedAddress[];
    try {
        addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname);
    }
    catch {
        throw new AppError('URL_FETCH_FAILED', '无法解析图片网址', { retryable: true });
    }
    if (!addresses.length || addresses.some(a => isForbiddenAddress(a.address) || isIP(a.address) !== a.family))
        throw new AppError('URL_FORBIDDEN', '图片网址解析到受限制的网络地址');
    return addresses[0]!;
}
export const pinnedRequest: UrlTransport = (url, address, signal, maxBytes) => new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const options: RequestOptions = { protocol: url.protocol, hostname, port: url.port || undefined, path: url.pathname + url.search, method: 'GET', family: address.family, agent: false, signal, headers: { Accept: 'image/png,image/jpeg,image/webp,image/avif', 'Accept-Encoding': 'identity' }, lookup: ((_host: unknown, _opts: unknown, callback: Function) => callback(null, address.address, address.family)) as RequestOptions['lookup'] };
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(options, (response: IncomingMessage) => {
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(response.headers))
            headers[key] = Array.isArray(value) ? value[0] : value;
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
            // 每跳使用独立连接，重定向无需读取响应体，立即关闭以免无限流占用资源。
            response.destroy();
            resolve({ status: response.statusCode!, headers, data: new Uint8Array() });
            return;
        }
        if (Number(headers['content-length']) > maxBytes) {
            const error = new AppError('FILE_TOO_LARGE', '图片不能超过20MB');
            response.destroy();
            req.destroy();
            reject(error);
            return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => { length += chunk.length; if (length > maxBytes) {
            response.destroy();
            req.destroy();
            reject(new AppError('FILE_TOO_LARGE', '图片不能超过20MB'));
        }
        else
            chunks.push(chunk); });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers, data: Buffer.concat(chunks) }));
        response.on('error', reject);
    });
    req.on('error', reject);
    req.end();
});
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error('URL request aborted'));
        const cleanup = () => { signal.removeEventListener('abort', abort); signal.removeEventListener('abort', cleanup); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted)
            abort();
        operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
        signal.addEventListener('abort', cleanup, { once: true });
    });
}
export async function fetchUrlImage(raw: string, externalSignal?: AbortSignal, options: UrlFetchOptions = {}) {
    const maxBytes = Math.min(options.maxBytes ?? LIMITS.maxFileBytes, LIMITS.maxFileBytes);
    const controller = new AbortController();
    const abort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', abort, { once: true });
    if (externalSignal?.aborted)
        abort();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? LIMITS.providerTimeoutMs);
    timer.unref();
    try {
        let url = parsePublicUrl(raw);
        for (let redirects = 0;; redirects++) {
            const address = await abortable(resolvePublicAddress(url, options.resolve), controller.signal);
            controller.signal.throwIfAborted();
            const response = await abortable((options.transport ?? pinnedRequest)(url, address, controller.signal, maxBytes), controller.signal);
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                if (redirects >= LIMITS.maxRedirects || !response.headers.location)
                    throw new AppError('URL_FORBIDDEN', '图片网址重定向次数过多或无效');
                url = parsePublicUrl(new URL(response.headers.location, url).toString());
                continue;
            }
            if (response.status < 200 || response.status >= 300)
                throw new AppError('URL_FETCH_FAILED', '无法下载图片，请确认网址可用', { retryable: true });
            if (response.data.byteLength > maxBytes)
                throw new AppError('FILE_TOO_LARGE', '图片不能超过20MB');
            if (!response.headers['content-type']?.toLowerCase().startsWith('image/'))
                throw new AppError('UNSUPPORTED_MIME', '网址没有返回图片');
            const info = await inspectImage(response.data, response.headers['content-type'], maxBytes);
            return { data: response.data, info, url: url.toString() };
        }
    }
    catch (error) {
        if (error instanceof AppError)
            throw error;
        throw new AppError('URL_FETCH_FAILED', '图片下载失败或超时，请稍后重试', { retryable: true });
    }
    finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', abort);
    }
}
//#endregion
