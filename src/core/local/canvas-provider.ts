import type { Operation } from '@tinypng/shared';
import type { PipelineProvider } from '../compression/provider';
import { CompressionCanceledError, CompressionProviderError, type CompressionOptions, type CompressionOutput } from '../compression/types';
import { planResize } from './resize';

const formatMime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;
const SUPPORTED_INPUT = new Set(['image/png', 'image/jpeg', 'image/webp']);

export interface DecodedImage {
  width: number;
  height: number;
  source: CanvasImageSource;
  close?(): void;
}

export interface Canvas2D {
  width: number;
  height: number;
  getContext(type: '2d'): Pick<CanvasRenderingContext2D, 'drawImage' | 'fillRect' | 'fillStyle' | 'imageSmoothingQuality' | 'imageSmoothingEnabled'> | null;
}

/** 可注入的 Canvas 能力，测试里用假实现；默认用浏览器/WebView */
export interface CanvasRuntime {
  decode(bytes: Uint8Array, mime: string): Promise<DecodedImage>;
  createCanvas(width: number, height: number): Canvas2D;
  encode(canvas: Canvas2D, mime: string, quality: number): Promise<Uint8Array>;
}

/**
 * 本地 Provider：Canvas 实现 compress / convert(png|jpeg|webp) / resize(contain|cover|inside)。
 * 按操作链顺序处理：所有 resize 依次作用在画布上，compress 决定质量，最后一个 convert 决定输出格式。
 * 全程不发网络请求。
 */
export class CanvasPipelineProvider implements PipelineProvider {
  constructor(private readonly runtime: CanvasRuntime = browserCanvasRuntime) {}

  async process(input: Uint8Array, operations: readonly Operation[], options: CompressionOptions, signal: AbortSignal): Promise<CompressionOutput> {
    throwIfAborted(signal);
    const inputMime = options.inputMime === 'image/jpg' ? 'image/jpeg' : options.inputMime ?? 'image/jpeg';
    if (!SUPPORTED_INPUT.has(inputMime)) throw new CompressionProviderError('UNSUPPORTED_FORMAT', '暂不支持此图片格式');

    let quality = options.quality;
    let outputMime = inputMime;
    for (const op of operations) {
      if (op.type === 'compress') {
        if (op.quality !== undefined) quality = op.quality;
      } else if (op.type === 'convert') {
        if (op.format === 'avif') throw new CompressionProviderError('OPERATION_UNSUPPORTED', '本地模式不支持转换为 AVIF');
        outputMime = formatMime[op.format];
      } else if (op.type !== 'resize') {
        throw new CompressionProviderError('OPERATION_UNSUPPORTED', '本地模式暂不支持操作：' + op.type);
      }
    }
    // PNG 无损：Canvas 忽略 quality，这里不做调色板量化（界面已提示效果不如 Tinify）

    const image = await this.runtime.decode(input, inputMime);
    try {
      throwIfAborted(signal);
      if (image.width * image.height > options.maxPixels) {
        throw new CompressionProviderError('PIXELS_TOO_LARGE', '图片像素数量超过限制');
      }

      let canvas = this.draw(image.source, image.width, image.height, undefined, outputMime);
      for (const op of operations) {
        if (op.type !== 'resize') continue;
        throwIfAborted(signal);
        const plan = planResize(canvas.width, canvas.height, op);
        if (plan.width * plan.height > options.maxPixels) {
          throw new CompressionProviderError('PIXELS_TOO_LARGE', '缩放后像素数量超过限制');
        }
        canvas = this.draw(canvas as unknown as CanvasImageSource, canvas.width, canvas.height, plan, outputMime);
      }

      throwIfAborted(signal);
      const bytes = await this.runtime.encode(canvas, outputMime, quality);
      throwIfAborted(signal);
      return {
        bytes,
        mime: outputMime,
        size: bytes.byteLength,
        width: canvas.width,
        height: canvas.height,
        ratio: input.byteLength > 0 ? bytes.byteLength / input.byteLength : 0
      };
    } finally {
      image.close?.();
    }
  }

  private draw(source: CanvasImageSource, srcW: number, srcH: number, plan: ReturnType<typeof planResize> | undefined, outputMime: string): Canvas2D {
    const p = plan ?? { width: srcW, height: srcH, sx: 0, sy: 0, sw: srcW, sh: srcH, dx: 0, dy: 0, dw: srcW, dh: srcH };
    const canvas = this.runtime.createCanvas(p.width, p.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new CompressionProviderError('PROVIDER_ERROR', '当前环境无法创建图片画布');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // JPEG 没有透明通道：contain 留白和透明像素都铺白底
    if (outputMime === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, p.width, p.height);
    }
    ctx.drawImage(source, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.dw, p.dh);
    return canvas;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new CompressionCanceledError();
}

export const browserCanvasRuntime: CanvasRuntime = {
  async decode(bytes, mime) {
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime });
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(blob);
        return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() };
      } catch {
        // 旧 WebView 降级到 HTMLImageElement
      }
    }
    // blob: URL 是本地对象，不产生网络请求
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight, source: image };
    } catch (error) {
      throw new CompressionProviderError('UNSUPPORTED_FORMAT', '图片解码失败', error);
    } finally {
      URL.revokeObjectURL(url);
    }
  },
  createCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
  encode(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
      (canvas as HTMLCanvasElement).toBlob(async blob => {
        if (!blob) return reject(new CompressionProviderError('PROVIDER_ERROR', '图片编码失败'));
        if (blob.type && blob.type !== mime) return reject(new CompressionProviderError('UNSUPPORTED_FORMAT', '当前环境不支持编码为 ' + mime));
        resolve(new Uint8Array(await blob.arrayBuffer()));
      }, mime, quality);
    });
  }
};
