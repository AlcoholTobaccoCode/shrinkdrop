import type { CompressionOptions } from './types';

export const supportedMimeTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type SupportedMimeType = (typeof supportedMimeTypes)[number];

export function isSupportedMimeType(mime: string): mime is SupportedMimeType {
  return supportedMimeTypes.includes(mime as SupportedMimeType);
}

export function validateInputSize(size: number, options: CompressionOptions): void {
  if (size > options.maxFileBytes) {
    throw new Error('图片超过单文件大小限制');
  }
}
