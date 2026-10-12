import { describe, expect, it } from 'vitest';
import { CompressionSession } from '../../src/core/compression/session';
import type { FileAdapter, TempFile } from '../../src/core/files/contracts';
import type { CompressionProvider } from '../../src/core/compression/provider';

function createAdapter(): FileAdapter {
  const tempFile: TempFile = {
    id: 'temp-1',
    name: 'photo.jpg',
    size: 4,
    mime: 'image/jpeg',
    relativePath: 'photo.jpg'
  };

  return {
    chooseFiles: async () => [],
    chooseDirectory: async () => [],
    read: async () => new Uint8Array([1, 2, 3, 4]),
    writeTemp: async () => tempFile,
    copyToClipboard: async () => undefined,
    replaceOriginal: async () => undefined,
    cleanup: async () => undefined
  };
}

function createProvider(): CompressionProvider {
  return {
    compress: async (input, _options, signal) => {
      if (signal.aborted) throw signal.reason;
      return {
        bytes: input.slice(0, 2),
        mime: 'image/jpeg',
        size: 2,
        width: 1,
        height: 1,
        ratio: 0.5
      };
    }
  };
}

describe('CompressionSession', () => {
  it('完成读取、压缩和写入流程', async () => {
    const session = new CompressionSession({ adapter: createAdapter(), provider: createProvider() });
    session.addFiles([{ id: 'source-1', name: 'photo.jpg', size: 4, mime: 'image/jpeg', relativePath: 'photo.jpg' }]);

    await session.run();

    expect(session.tasks[0]?.status).toBe('completed');
    expect(session.tasks[0]?.compressedSize).toBe(2);
    expect(session.tasks[0]?.tempFile?.id).toBe('temp-1');
    expect(session.tasks[0]?.outputs.map(o => o.status)).toEqual(['completed']);
    expect(session.batch.status).toBe('completed');
  });

  it('Provider 失败后任务进入 failed', async () => {
    const provider: CompressionProvider = {
      compress: async () => {
        throw new Error('provider down');
      }
    };
    const session = new CompressionSession({ adapter: createAdapter(), provider });
    session.addFiles([{ id: 'source-1', name: 'photo.jpg', size: 4, mime: 'image/jpeg', relativePath: 'photo.jpg' }]);

    await session.run();

    expect(session.tasks[0]?.status).toBe('failed');
    expect(session.tasks[0]?.error?.message).toBe('provider down');
  });

  it('取消后不会写入临时文件或标记为成功', async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    let writeCount = 0;
    const provider: CompressionProvider = {
      compress: async (_input, _options, signal) => {
        markStarted?.();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        throw new Error('unreachable');
      }
    };
    const adapter = createAdapter();
    const session = new CompressionSession({
      adapter: {
        ...adapter,
        writeTemp: async (...args) => {
          writeCount += 1;
          return adapter.writeTemp(...args);
        }
      },
      provider
    });
    session.addFiles([{ id: 'source-1', name: 'photo.jpg', size: 4, mime: 'image/jpeg', relativePath: 'photo.jpg' }]);

    const run = session.run();
    await started;
    session.cancel(session.tasks[0]!.id);
    await run;

    expect(session.tasks[0]?.status).toBe('canceled');
    expect(writeCount).toBe(0);
  });
});
