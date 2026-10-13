import sharp from 'sharp';
import { z } from 'zod';
import { LIMITS, type CreateBatchRequest, type ImageInfo, type ImageProviderManifest, type Operation } from '@tinypng/shared';
import { AppError } from './errors';
//#region 操作链与输入校验
const dimension = z.number().int().positive().max(16384);
const operationSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('compress'), quality: z.number().min(0).max(1).optional() }).strict(),
    z.object({ type: z.literal('convert'), format: z.enum(['png', 'jpeg', 'webp', 'avif']) }).strict(),
    z.object({ type: z.literal('resize'), width: dimension.optional(), height: dimension.optional(), fit: z.enum(['contain', 'cover', 'inside']) }).strict(),
    z.object({ type: z.literal('smart-resize'), width: dimension, height: dimension, focus: z.enum(['auto', 'center']).optional() }).strict(),
    z.object({ type: z.literal('crop'), width: dimension, height: dimension, x: z.number().int().nonnegative().optional(), y: z.number().int().nonnegative().optional() }).strict(),
    z.object({ type: z.literal('smart-crop'), width: dimension, height: dimension }).strict(),
    z.object({ type: z.literal('metadata'), preserve: z.array(z.enum(['copyright', 'gps', 'creation-date'])) }).strict(),
]);
const batchSchema = z.object({
    providerId: z.string().min(1), operations: z.array(operationSchema).min(1).max(16),
    destinations: z.array(z.object({ type: z.literal('download') }).strict()).min(1).max(16),
}).strict();
export function validateBatch(body: unknown, manifests: ImageProviderManifest[]): CreateBatchRequest {
    const parsed = batchSchema.safeParse(body);
    if (!parsed.success)
        throw new AppError('VALIDATION_FAILED', '请检查操作参数和下载目的地');
    const batch = parsed.data;
    const manifest = manifests.find(p => p.id === batch.providerId && p.processing === 'cloud');
    if (!manifest)
        throw new AppError('PROVIDER_UNAVAILABLE', '处理线路不可用', { providerId: batch.providerId });
    for (const operation of batch.operations) {
        if (operation.type === 'resize' && (!operation.width && !operation.height || operation.fit !== 'inside' && (!operation.width || !operation.height)))
            throw new AppError('VALIDATION_FAILED', '缩放需要有效的宽高；适应或填满需要同时填写宽高');
        if (!supports(operation, manifest))
            throw new AppError('OPERATION_UNSUPPORTED', '当前线路不支持此操作', { providerId: manifest.id, suggestProviderId: manifest.id === 'anonymous-tinify' ? 'official-tinify' : undefined });
    }
    return batch;
}
function supports(operation: Operation, manifest: ImageProviderManifest): boolean {
    switch (operation.type) {
        case 'compress': return manifest.capabilities.compress;
        case 'convert': return manifest.capabilities.convert.includes(operation.format);
        case 'resize': return manifest.capabilities.resize;
        // 第一阶段只开放压缩、格式转换、缩放。
        default: return false;
    }
}
const mimeByFormat: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif' };
export async function inspectImage(data: Uint8Array, declaredMime: string | undefined, maxBytes = LIMITS.maxFileBytes): Promise<ImageInfo> {
    if (data.byteLength > Math.min(maxBytes, LIMITS.maxFileBytes))
        throw new AppError('FILE_TOO_LARGE', '图片不能超过20MB');
    try {
        const decoder = sharp(data, { failOn: 'warning', limitInputPixels: 100000000 });
        const meta = await decoder.metadata();
        const mime = meta.format === 'heif' && meta.compression === 'av1' ? 'image/avif' : meta.format && mimeByFormat[meta.format];
        const declared = declaredMime?.split(';')[0]?.trim().toLowerCase();
        if (!mime || !meta.width || !meta.height || declared && declared !== mime)
            throw new Error('image type mismatch');
        // metadata只读取头部，stats会实际解码，拦住截断图片或伪造头部。
        await decoder.stats();
        return { mime, size: data.byteLength, width: meta.width, height: meta.height };
    }
    catch {
        throw new AppError('UNSUPPORTED_MIME', '请添加有效的PNG、JPEG、WebP或AVIF图片');
    }
}
export const urlItemsSchema = z.object({ urls: z.array(z.string().min(1).max(8192)).min(1).max(100) }).strict();
export const retrySchema = z.object({ scope: z.enum(['all', 'outputs']) }).strict();
//#endregion
