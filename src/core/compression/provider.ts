import type { Operation } from '@tinypng/shared';
import { CompressionProviderError, type CompressionOptions, type CompressionOutput } from './types';

/** 单步压缩能力（Canvas 等），保留旧接口 */
export interface CompressionProvider {
  compress(input: Uint8Array, options: CompressionOptions, signal: AbortSignal): Promise<CompressionOutput>;
}

/** 按操作链处理一张图 */
export interface PipelineProvider {
  process(input: Uint8Array, operations: readonly Operation[], options: CompressionOptions, signal: AbortSignal): Promise<CompressionOutput>;
}

const formatMime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif' } as const;
const LOCAL_FORMATS = new Set(['png', 'jpeg', 'webp']);

/**
 * 把 compress + convert 映射到单次编码；其余操作（resize 在 D3 用 Canvas 实现）
 * 当前抛 OPERATION_UNSUPPORTED，与 Server 422 一致。
 */
export function toPipelineProvider(provider: CompressionProvider | PipelineProvider): PipelineProvider {
  if ('process' in provider) return provider;
  return {
    process(input, operations, options, signal) {
      const next: CompressionOptions = { ...options };
      for (const op of operations) {
        if (op.type === 'compress') {
          if (op.quality !== undefined) next.quality = op.quality;
        } else if (op.type === 'convert' && LOCAL_FORMATS.has(op.format)) {
          next.outputMime = formatMime[op.format];
        } else {
          return Promise.reject(new CompressionProviderError('OPERATION_UNSUPPORTED', '本地模式暂不支持操作：' + op.type));
        }
      }
      return provider.compress(input, next, signal);
    }
  };
}
