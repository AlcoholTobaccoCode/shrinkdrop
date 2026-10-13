import { describe, expect, it, vi } from 'vitest';
import { NetworkGuard, NetworkBlockedError } from '../../src/core/local/network-guard';
import { LocalExecutor } from '../../src/core/local/local-executor';
import type { FileAdapter, SourceFile } from '../../src/core/files/contracts';

//#region 原生 IPC fixture
const ipcOptions = (): RequestInit => ({
  method: 'POST',
  headers: new Headers({
    'Content-Type': 'application/json',
    'Tauri-Callback': '123',
    'Tauri-Error': '456',
    'Tauri-Invoke-Key': 'native-frame-key'
  }),
  body: '{}'
});

function setup(native = true) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('[1,2,3,4]'));
  const target = {
    fetch,
    ...(native ? { __TAURI_INTERNALS__: { invoke: () => undefined, convertFileSrc: () => undefined } } : {})
  } as unknown as typeof globalThis & Record<string, unknown>;
  return { fetch, target, guard: new NetworkGuard(target) };
}
//#endregion

describe('NetworkGuard 原生 IPC 边界', () => {
  it.each(['ipc://localhost', 'http://ipc.localhost'])('固定内部地址 %s 的原生文件请求不被计为联网', async origin => {
    const { fetch, target, guard } = setup();
    const options = ipcOptions();
    await guard.run(async () => {
      const response = await target.fetch(origin + '/read_file', options);
      expect(await response.json()).toEqual([1, 2, 3, 4]);
    });
    expect(guard.blocked).toBe(0);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(origin + '/read_file', options);
    expect(target.fetch).toBe(fetch);
  });

  it.each(['choose_files', 'choose_directory', 'read_file', 'write_temp', 'save_temp_file', 'cleanup_temp_files'])('仅允许本地文件能力 %s', async command => {
    const { fetch, target, guard } = setup();
    await guard.run(() => target.fetch('ipc://localhost/' + command, ipcOptions()));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(guard.blocked).toBe(0);
  });

  it('URL 与 Request 输入仍按同一 IPC 能力规则校验', async () => {
    const { fetch, target, guard } = setup();
    await guard.run(async () => {
      await target.fetch(new URL('ipc://localhost/read_file'), ipcOptions());
      await target.fetch(new Request('http://ipc.localhost/write_temp', ipcOptions()));
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(guard.blocked).toBe(0);
  });

  it('原生二进制载荷、0号callback与带符号invoke key均可通过', async () => {
    const { fetch, target, guard } = setup();
    const options = ipcOptions();
    const headers = options.headers as Headers;
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Tauri-Callback', '0');
    headers.set('Tauri-Error', '4294967295');
    headers.set('Tauri-Invoke-Key', '01#?2=3&4[]5{}6@7$8!');
    options.body = new Uint8Array([1, 2, 3]);
    await guard.run(() => target.fetch('ipc://localhost/write_temp', options));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(guard.blocked).toBe(0);
  });

  it('普通浏览器即使请求同名主机也不放行', async () => {
    const { fetch, target, guard } = setup(false);
    await guard.run(async () => {
      await expect(target.fetch('http://ipc.localhost/read_file', ipcOptions())).rejects.toBeInstanceOf(NetworkBlockedError);
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(guard.blocked).toBe(1);
  });

  it.each([
    'http://localhost/read_file', 'http://127.0.0.1/read_file', 'https://ipc.localhost/read_file',
    'http://ipc.localhost.evil.example/read_file', 'http://ipc.localhost./read_file',
    'http://ipc.localhost:8787/read_file', 'ipc://localhost:8787/read_file', 'ipc://evil.example/read_file',
    'http://user:password@ipc.localhost/read_file', 'ipc://user@localhost/read_file',
    'http://ipc.localhost/read_file?url=https://evil.example', 'ipc://localhost/read_file#x',
    'http://ipc.localhost/plugin%3Ahttp%7Cfetch', 'ipc://localhost/replace_original',
    'ipc://localhost/read_file/extra', 'ipc://localhost/%72ead_file', 'https://evil.example/upload'
  ])('拦截外部请求或能力越界 %s', async url => {
    const { fetch, target, guard } = setup();
    await guard.run(async () => {
      await expect(target.fetch(url, ipcOptions())).rejects.toBeInstanceOf(NetworkBlockedError);
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(guard.blocked).toBe(1);
  });

  it.each(['method', 'key', 'callback', 'callbackOverflow', 'error', 'contentType'] as const)('缺少有效原生调用特征 %s 时拦截', async missing => {
    const { fetch, target, guard } = setup();
    const options = ipcOptions();
    const headers = options.headers as Headers;
    if (missing === 'method') options.method = 'GET';
    if (missing === 'key') headers.delete('Tauri-Invoke-Key');
    if (missing === 'callback') headers.set('Tauri-Callback', 'not-a-callback');
    if (missing === 'callbackOverflow') headers.set('Tauri-Callback', '4294967296');
    if (missing === 'error') headers.delete('Tauri-Error');
    if (missing === 'contentType') headers.set('Content-Type', 'text/plain');
    await guard.run(async () => {
      await expect(target.fetch('http://ipc.localhost/read_file', options)).rejects.toBeInstanceOf(NetworkBlockedError);
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(guard.blocked).toBe(1);
  });

  it('两张本地图片经原生读取与临时输出完成，网络拦截数保持 0', async () => {
    const { fetch, target, guard } = setup();
    const adapter: FileAdapter = {
      chooseFiles: async () => [], chooseDirectory: async () => [],
      read: async () => Uint8Array.from(await (await target.fetch('http://ipc.localhost/read_file', ipcOptions())).json()),
      writeTemp: async (id, bytes, extension, mime) => {
        await target.fetch('http://ipc.localhost/write_temp', ipcOptions());
        return { id, name: id + '.' + extension, relativePath: id, size: bytes.length, mime };
      },
      copyToClipboard: async () => undefined, replaceOriginal: async () => undefined, cleanup: async () => undefined
    };
    const executor = new LocalExecutor({ adapter, guard,
      pipeline: { providerId: 'local', operations: [{ type: 'compress' }], destinations: [{ type: 'download' }] },
      provider: { process: async bytes => ({ bytes, size: bytes.length, mime: 'image/png', width: 1, height: 1, ratio: 1 }) }
    });
    const file = (id: string): SourceFile => ({ id, name: id + '.png', size: 4, mime: 'image/png', relativePath: id + '.png' });
    executor.addFiles([file('one'), file('two')]);
    await executor.start();
    expect(executor.items.map(item => item.status)).toEqual(['completed', 'completed']);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(guard.blocked).toBe(0);
    expect(guard.active).toBe(false);
  });
});
