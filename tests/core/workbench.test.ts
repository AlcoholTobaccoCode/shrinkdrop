import { describe, expect, it } from 'vitest';
import { LIMITS } from '@tinypng/shared';
import { CompressionSession } from '../../src/core/compression/session';
import type { CompressionProvider } from '../../src/core/compression/provider';
import type { FileAdapter, SourceFile } from '../../src/core/files/contracts';
import { canRetryOutputs, displayStatus } from '../../src/core/workbench/model';
import { calculateCompressionStats } from '../../src/core/compression/stats';

const file = (id: string): SourceFile => ({ id, name: id + '.jpg', size: 4, mime: 'image/jpeg', relativePath: id + '.jpg' });

function adapter(): FileAdapter {
  return {
    chooseFiles: async () => [],
    chooseDirectory: async () => [],
    read: async () => new Uint8Array([1, 2, 3, 4]),
    writeTemp: async (id, _b, ext, mime) => ({ id, name: id + '.' + ext, size: 2, mime, relativePath: id }),
    copyToClipboard: async () => undefined,
    replaceOriginal: async () => undefined,
    cleanup: async () => undefined
  };
}

function provider(onCall?: (opts: { quality: number; outputMime?: string }) => void, gate?: Promise<void>): CompressionProvider {
  return {
    compress: async (input, options) => {
      onCall?.(options);
      if (gate) await gate;
      return { bytes: input.slice(0, 2), mime: options.outputMime ?? 'image/jpeg', size: 2, width: 1, height: 1, ratio: 0.5 };
    }
  };
}

describe('工作台模型（D1）', () => {
  it('加文件只生成草稿，不自动开始', async () => {
    let calls = 0;
    const session = new CompressionSession({ adapter: adapter(), provider: provider(() => { calls += 1; }) });
    session.addFiles([file('a'), file('b')]);
    await new Promise(r => setTimeout(r, 10));
    expect(calls).toBe(0);
    expect(session.tasks.map(t => t.status)).toEqual(['draft', 'draft']);
    expect(session.batch.status).toBe('draft');
    expect(calculateCompressionStats(session.tasks).draft).toBe(2);
    await session.run();
    expect(calls).toBe(2);
    expect(session.tasks.every(t => t.status === 'completed' && t.attempts === 1)).toBe(true);
  });

  it('状态按 draft→queued→uploading→processing→saving→completed 流转', async () => {
    const seen: string[] = [];
    const session = new CompressionSession({
      adapter: adapter(),
      provider: provider(),
      onUpdate: tasks => { const s = tasks[0]?.status; if (s && seen.at(-1) !== s) seen.push(s); }
    });
    session.addFiles([file('a')]);
    await session.run();
    expect(seen).toEqual(['draft', 'queued', 'uploading', 'processing', 'saving', 'completed']);
  });

  it('默认并发为 LIMITS.concurrency（5）', async () => {
    let running = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const session = new CompressionSession({
      adapter: adapter(),
      provider: { compress: async (input) => { running += 1; peak = Math.max(peak, running); await gate; running -= 1; return { bytes: input, mime: 'image/jpeg', size: 4, width: 1, height: 1, ratio: 1 }; } }
    });
    session.addFiles(Array.from({ length: 8 }, (_, i) => file('f' + i)));
    const run = session.run();
    await new Promise(r => setTimeout(r, 10));
    expect(peak).toBe(LIMITS.concurrency);
    release();
    await run;
    expect(peak).toBe(5);
  });

  it('操作链传给 Provider：compress 质量 + convert 格式', async () => {
    let got: { quality: number; outputMime?: string } | undefined;
    const session = new CompressionSession({
      adapter: adapter(),
      provider: provider(o => { got = o; }),
      pipeline: { providerId: 'local', operations: [{ type: 'compress', quality: 0.6 }, { type: 'convert', format: 'webp' }], destinations: [{ type: 'download' }] }
    });
    session.addFiles([file('a')]);
    await session.run();
    expect(got?.quality).toBe(0.6);
    expect(got?.outputMime).toBe('image/webp');
    expect(session.tasks[0]?.tempFile?.name).toBe(session.tasks[0]!.id + '.webp');
  });

  it('本地不支持的操作直接失败（OPERATION_UNSUPPORTED）', async () => {
    const session = new CompressionSession({
      adapter: adapter(),
      provider: provider(),
      pipeline: { providerId: 'local', operations: [{ type: 'smart-crop', width: 10, height: 10 }], destinations: [{ type: 'download' }] }
    });
    session.addFiles([file('a')]);
    await session.run();
    expect(session.tasks[0]?.status).toBe('failed');
    expect(session.tasks[0]?.error?.code).toBe('OPERATION_UNSUPPORTED');
    expect(displayStatus(session.tasks[0]!)).toBe('failed');
  });

  it('多输出：一个成功一个失败 → partial，可只重试输出', async () => {
    let fail = true;
    let providerCalls = 0;
    const session = new CompressionSession({
      adapter: adapter(),
      provider: provider(() => { providerCalls += 1; }),
      pipeline: { providerId: 'local', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }, { type: 'object-storage', profileId: 'p' }] },
      writeOutput: async (_i, d) => { if (d.type === 'object-storage' && fail) throw new Error('S3 down'); }
    });
    session.addFiles([file('a')]);
    await session.run();
    const item = session.tasks[0]!;
    expect(item.status).toBe('completed');
    expect(item.outputs.map(o => o.status)).toEqual(['completed', 'failed']);
    expect(item.outputs[1]?.error?.code).toBe('OUTPUT_FAILED');
    expect(displayStatus(item)).toBe('partial');
    expect(canRetryOutputs(item)).toBe(true);
    expect(session.batch.status).toBe('partial');

    fail = false;
    await session.retry(item.id, 'outputs');
    expect(providerCalls).toBe(1);
    expect(item.outputs.map(o => o.status)).toEqual(['completed', 'completed']);
    expect(displayStatus(item)).toBe('completed');
  });

  it('有结果但所有输出失败 → output-failed，只重试输出、不重跑 Provider', async () => {
    let fail = true;
    let providerCalls = 0;
    const session = new CompressionSession({
      adapter: adapter(),
      provider: provider(() => { providerCalls += 1; }),
      writeOutput: async () => { if (fail) throw new Error('disk full'); }
    });
    session.addFiles([file('a')]);
    await session.run();
    const item = session.tasks[0]!;
    expect(item.status).toBe('failed');
    expect(item.output).toBeDefined();
    expect(displayStatus(item)).toBe('output-failed');
    expect(canRetryOutputs(item)).toBe(true);
    expect(calculateCompressionStats(session.tasks).outputFailed).toBe(1);

    fail = false;
    await session.retry(item.id, 'outputs');
    expect(providerCalls).toBe(1);
    expect(item.status).toBe('completed');
  });

  it('取消草稿直接变 canceled', () => {
    const session = new CompressionSession({ adapter: adapter(), provider: provider() });
    session.addFiles([file('a')]);
    session.cancel(session.tasks[0]!.id);
    expect(session.tasks[0]?.status).toBe('canceled');
  });

  it('处理中继续添加的图片保持草稿', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const session = new CompressionSession({ adapter: adapter(), provider: provider(undefined, gate) });
    session.addFiles([file('a')]);
    const run = session.run();
    session.addFiles([file('b')]);
    expect(session.tasks[1]?.status).toBe('draft');
    release();
    await run;
    expect(session.tasks[1]?.status).toBe('draft');
    expect(session.draftCount).toBe(1);
  });
});
