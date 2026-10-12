import { CompressionProviderError, CompressionCanceledError } from '../../core/compression/types';
import { isSupportedMimeType } from '../../core/compression/options';
import type { CompressionOptions, CompressionOutput } from '../../core/compression/types';
import type { CompressionProvider } from '../../core/compression/provider';

export class BrowserImageProvider implements CompressionProvider {
  async compress(input: Uint8Array, options: CompressionOptions, signal: AbortSignal): Promise<CompressionOutput> {
    throwIfAborted(signal);
    const sourceBlob = new Blob([toArrayBuffer(input)], { type: 'application/octet-stream' });
    const image = await decodeImage(sourceBlob, signal);
    throwIfAborted(signal);

    const width = image.width;
    const height = image.height;
    if (width * height > options.maxPixels) {
      closeImage(image);
      throw new CompressionProviderError('PIXELS_TOO_LARGE', '图片像素数量超过限制');
    }

    const mime = normalizeMime(options.inputMime ?? sourceBlob.type, image);
    if (!isSupportedMimeType(mime)) {
      closeImage(image);
      throw new CompressionProviderError('UNSUPPORTED_FORMAT', '暂不支持此图片格式');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      closeImage(image);
      throw new CompressionProviderError('PROVIDER_ERROR', '当前环境无法创建图片画布');
    }

    context.drawImage(image, 0, 0);
    closeImage(image);
    throwIfAborted(signal);

    const outputMime = options.outputMime ?? mime;
    const blob = await canvasToBlob(canvas, outputMime, options.quality, signal);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    throwIfAborted(signal);

    return {
      bytes,
      mime: outputMime,
      size: bytes.byteLength,
      width,
      height,
      ratio: input.byteLength > 0 ? bytes.byteLength / input.byteLength : 0
    };
  }
}

function normalizeMime(sourceMime: string, image: ImageBitmap | HTMLImageElement): string {
  if (isSupportedMimeType(sourceMime)) return sourceMime;
  const source = image instanceof ImageBitmap ? '' : sourceMime;
  if (source === 'image/jpg') return 'image/jpeg';
  return source || 'image/jpeg';
}

async function decodeImage(blob: Blob, signal: AbortSignal): Promise<ImageBitmap | HTMLImageElement> {
  throwIfAborted(signal);
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      // 继续使用 HTMLImageElement 作为旧 WebView 降级方案。
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number, signal: AbortSignal): Promise<Blob> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) {
        reject(new CompressionProviderError('PROVIDER_ERROR', '图片编码失败'));
        return;
      }
      try {
        throwIfAborted(signal);
        resolve(blob);
      } catch (error) {
        reject(error);
      }
    }, mime, quality);
  });
}

function closeImage(image: ImageBitmap | HTMLImageElement): void {
  if (image instanceof ImageBitmap) image.close();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CompressionCanceledError();
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
