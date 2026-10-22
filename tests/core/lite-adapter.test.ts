import { describe, expect, it, vi } from 'vitest';
import { createNativeAdapter } from '../../src/platform/native';
import { isTauriRuntime } from '../../src/platform';
import type { NativeInvoke } from '../../src/platform/native';

describe('shrinkdrop native boundary', () => {
  it('uses the Tauri protocol marker and rejects a browser with just a tauri-shaped global', () => {
    expect(isTauriRuntime({ __TAURI__: {} })).toBe(false);
    expect(isTauriRuntime({ __TAURI_INTERNALS__: {} })).toBe(true);
  });

  it('uses only registered source IDs and the agreed compression commands', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'read_file') return [1, 2];
      if (command === 'compress_image') return { tempFileId: 'temp' };
      if (command === 'save_temp_file') return { saved: true };
      if (command === 'save_results') return { saved: 1, failed: [], canceled: false };
      if (command === 'overwrite_temp_file') return { overwritten: true };
      if (command === 'overwrite_results') return { overwritten: 1, failed: [], canceled: false };
      return [];
    });
    const adapter = createNativeAdapter(invoke as NativeInvoke);
    expect(adapter.desktop).toBe(true);
    await adapter.chooseFiles(); await adapter.chooseDirectory();
    expect(await adapter.readFile({ id: 'source', name: 'a.png', size: 2, mime: 'image/png', relativePath: 'a.png' }))
      .toEqual(new Uint8Array([1, 2]));
    await adapter.compress('source', 'session-item-1');
    await adapter.cancel('session-item-1');
    await adapter.save('temp', 'a.png'); await adapter.saveResults(['temp']);
    await adapter.overwrite('temp'); await adapter.overwriteResults(['temp']); await adapter.cleanup('session');
    expect(invoke.mock.calls).toEqual([
      ['choose_files'], ['choose_directory'], ['read_file', { sourceId: 'source' }],
      ['compress_image', { sourceId: 'source', taskId: 'session-item-1' }],
      ['cancel_compression', { taskId: 'session-item-1' }],
      ['save_temp_file', { tempFileId: 'temp', suggestedName: 'a.png' }],
      ['save_results', { tempFileIds: ['temp'] }],
      ['overwrite_temp_file', { tempFileId: 'temp' }], ['overwrite_results', { tempFileIds: ['temp'] }],
      ['cleanup_temp_files', { sessionId: 'session' }]
    ]);
  });
});
