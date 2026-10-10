import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTauriFileAdapter, type TauriInvoke } from '../../src/platform/tauri/file-adapter';

describe('Tauri 文件适配器契约', () => {
  it('返回不包含真实路径的来源文件，并把读取结果转成 Uint8Array', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke: TauriInvoke = async (command, args) => {
      calls.push({ command, args });
      if (command === 'choose_files') {
        return [
          {
            id: 'source-1',
            name: 'sample.png',
            size: 3,
            mime: 'image/png',
            relativePath: 'sample.png'
          }
        ];
      }
      if (command === 'read_file') return [1, 2, 3];
      throw new Error(`unexpected command: ${command}`);
    };

    const adapter = createTauriFileAdapter({ invoke });
    const [source] = await adapter.chooseFiles();
    const bytes = await adapter.read(source!);

    expect(source).toMatchObject({ id: 'source-1', name: 'sample.png', relativePath: 'sample.png' });
    expect(source).not.toHaveProperty('path');
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls).toEqual([
      { command: 'choose_files', args: undefined },
      { command: 'read_file', args: { sourceId: 'source-1' } }
    ]);
  });

  it('写入临时文件时只发送字节和清洗后的扩展名', async () => {
    let received: Record<string, unknown> | undefined;
    const invoke: TauriInvoke = async (command, args) => {
      if (command !== 'write_temp') throw new Error(`unexpected command: ${command}`);
      received = args;
      return {
        id: 'temp-1',
        name: 'task-1.webp',
        size: 2,
        mime: 'image/webp',
        relativePath: 'task-1.webp'
      };
    };

    const adapter = createTauriFileAdapter({ invoke });
    const temp = await adapter.writeTemp('task-1', new Uint8Array([9, 8]), '.w##ebp', 'image/webp');

    expect(temp.id).toBe('temp-1');
    expect(received).toEqual({ taskId: 'task-1', bytes: [9, 8], extension: 'webp', mime: 'image/webp' });
  });

  it('转发复制、原子替换和会话清理命令，且不会把文件内容塞进剪贴板契约', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke: TauriInvoke = async (command, args) => {
      calls.push({ command, args });
      return undefined;
    };
    const adapter = createTauriFileAdapter({ invoke });

    await adapter.copyToClipboard([
      { id: 'temp-1', name: 'a.png', size: 1, mime: 'image/png', relativePath: 'nested/a.png', handle: 'temp-1' }
    ]);
    await adapter.replaceOriginal(
      { id: 'temp-1', name: 'a.png', size: 1, mime: 'image/png', relativePath: 'nested/a.png', handle: 'temp-1' },
      { id: 'source-1', name: 'a.png', size: 2, mime: 'image/png', relativePath: 'nested/a.png' }
    );
    await adapter.cleanup('session-1');

    expect(calls).toEqual([
      { command: 'copy_temp_files', args: { tempFileIds: ['temp-1'] } },
      { command: 'replace_original', args: { tempFileId: 'temp-1', sourceId: 'source-1' } },
      { command: 'cleanup_temp_files', args: { sessionId: 'session-1' } }
    ]);
  });

  it('默认 capability 只给主窗口核心能力和文件选择器权限', () => {
    const capability = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src-tauri/capabilities/default.json'), 'utf8')
    ) as { windows: string[]; permissions: string[] };

    expect(capability.windows).toEqual(['main']);
    expect(capability.permissions).toContain('core:default');
    expect(capability.permissions).toContain('dialog:default');
    expect(capability.permissions.some(permission => permission.includes('fs:allow-all'))).toBe(false);
  });
});
