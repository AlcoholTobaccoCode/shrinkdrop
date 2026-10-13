import type { ImageFormat, Operation, ProcessingPolicy } from '@tinypng/shared';
import type { Pipeline } from './model';

const mimeToFormat: Record<string, ImageFormat> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/webp': 'webp', 'image/avif': 'avif' };

/** 参数错误先在操作面板提示，不能等开始后才逐张失败。 */
export function pipelineValidation(pipeline: Pipeline): string | undefined {
  if (!pipeline.operations.length) return '至少开启一项操作';
  for (const operation of pipeline.operations) {
    if (operation.type !== 'resize') continue;
    const valid = (n: number | undefined) => n !== undefined && Number.isInteger(n) && n > 0;
    if (operation.fit !== 'inside' && (!valid(operation.width) || !valid(operation.height))) return '固定尺寸需要填写有效的宽和高';
    if (!valid(operation.width) && !valid(operation.height)) return '填写有效的宽或高';
  }
  return undefined;
}

export function convertFormat(pipeline: Pipeline): ImageFormat | undefined {
  const ops = pipeline.operations.filter((op): op is Extract<Operation, { type: 'convert' }> => op.type === 'convert');
  return ops.at(-1)?.format;
}

/** 输出格式集合：有 convert 用 convert，否则跟随各输入 */
export function outputFormats(pipeline: Pipeline, inputMimes: readonly string[]): Set<ImageFormat> {
  const forced = convertFormat(pipeline);
  if (forced) return new Set([forced]);
  return new Set(inputMimes.map(m => mimeToFormat[m]).filter((f): f is ImageFormat => Boolean(f)));
}

/** 质量滑块：输出全是 PNG 时禁用（Canvas/Tinify 的 PNG 都不吃 quality） */
export function qualityHint(pipeline: Pipeline, inputMimes: readonly string[]): { disabled: boolean; note?: string } {
  const formats = outputFormats(pipeline, inputMimes);
  if (formats.size > 0 && [...formats].every(f => f === 'png')) return { disabled: true, note: '只对 JPG 和 WebP 有效' };
  if (formats.has('png')) return { disabled: false, note: '只对 JPG 和 WebP 有效，PNG 不受影响' };
  return { disabled: false };
}

/** 本地 + 压缩 + PNG 输出：内联提示（非弹窗） */
export function localPngHint(mode: ProcessingPolicy, pipeline: Pipeline, inputMimes: readonly string[]): string | undefined {
  if (mode !== 'private-local') return undefined;
  if (!pipeline.operations.some(op => op.type === 'compress')) return undefined;
  if (!outputFormats(pipeline, inputMimes).has('png')) return undefined;
  return '本地模式对 PNG 压缩效果有限，建议用云端';
}

/** contain 缩放：补边提示。PNG/WebP 透明，JPG 白色 */
export function containHint(op: Operation, pipeline: Pipeline, inputMimes: readonly string[]): string | undefined {
  if (op.type !== 'resize' || op.fit !== 'contain' || !op.width || !op.height) return undefined;
  const size = String(op.width) + '×' + String(op.height);
  const formats = outputFormats(pipeline, inputMimes);
  const hasJpeg = formats.has('jpeg');
  const hasAlpha = [...formats].some(f => f !== 'jpeg');
  if (hasJpeg && !hasAlpha) return '补白色边到 ' + size;
  if (hasAlpha && !hasJpeg) return '补透明边到 ' + size;
  return '补透明或白色边到 ' + size + '（PNG/WebP 透明，JPG 白色）';
}
