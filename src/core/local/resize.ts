import type { Operation } from '@tinypng/shared';

export type ResizeOp = Extract<Operation, { type: 'resize' }>;

/** 源图在画布上的绘制方式：从源图裁 (sx,sy,sw,sh) 画到画布 (dx,dy,dw,dh)，画布尺寸 width×height */
export interface ResizePlan {
  width: number;
  height: number;
  sx: number; sy: number; sw: number; sh: number;
  dx: number; dy: number; dw: number; dh: number;
}

/**
 * - inside：等比缩到框内，不放大；画布 = 缩放后尺寸
 * - contain：等比放进框内（可放大），画布 = 框尺寸，四周留白（透明/白底）居中
 * - cover：等比铺满框（可放大），画布 = 框尺寸，居中裁掉多余部分
 * 只给宽或高时三种都按等比缩放处理（inside 仍不放大）。
 */
export function planResize(srcW: number, srcH: number, op: ResizeOp): ResizePlan {
  if (srcW <= 0 || srcH <= 0) throw new RangeError('源图尺寸无效');
  const { width, height, fit } = op;
  if ((width !== undefined && width <= 0) || (height !== undefined && height <= 0)) throw new RangeError('缩放尺寸必须大于 0');
  const full = { sx: 0, sy: 0, sw: srcW, sh: srcH };

  if (width === undefined && height === undefined) {
    return { width: srcW, height: srcH, ...full, dx: 0, dy: 0, dw: srcW, dh: srcH };
  }

  if (width === undefined || height === undefined) {
    let scale = width !== undefined ? width / srcW : height! / srcH;
    if (fit === 'inside') scale = Math.min(scale, 1);
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    return { width: w, height: h, ...full, dx: 0, dy: 0, dw: w, dh: h };
  }

  if (fit === 'cover') {
    const scale = Math.max(width / srcW, height / srcH);
    const sw = Math.min(srcW, width / scale);
    const sh = Math.min(srcH, height / scale);
    return { width, height, sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh, dx: 0, dy: 0, dw: width, dh: height };
  }

  let scale = Math.min(width / srcW, height / srcH);
  if (fit === 'inside') {
    scale = Math.min(scale, 1);
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    return { width: w, height: h, ...full, dx: 0, dy: 0, dw: w, dh: h };
  }
  const dw = srcW * scale;
  const dh = srcH * scale;
  return { width, height, ...full, dx: (width - dw) / 2, dy: (height - dh) / 2, dw, dh };
}
