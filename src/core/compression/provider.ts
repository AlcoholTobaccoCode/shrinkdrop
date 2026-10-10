import type { CompressionOptions, CompressionOutput } from './types';

export interface CompressionProvider {
  compress(input: Uint8Array, options: CompressionOptions, signal: AbortSignal): Promise<CompressionOutput>;
}
