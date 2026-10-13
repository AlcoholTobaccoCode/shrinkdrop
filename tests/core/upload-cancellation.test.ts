import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, xhrUpload } from '../../src/core/cloud/api-client';

afterEach(() => vi.unstubAllGlobals());

describe('上传取消边界', () => {
  it.each(['before-open', 'during-open'] as const)('%s取消时XHR不发送任何请求', async when => {
    const controller = new AbortController();
    let sent = 0;
    class FakeXHR {
      upload = {};
      status = 200;
      responseText = '{}';
      onload?: () => void;
      onabort?: () => void;
      open() { if (when === 'during-open') controller.abort(); }
      setRequestHeader() {}
      send() { sent++; this.onload?.(); }
      abort() { this.onabort?.(); }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    if (when === 'before-open') controller.abort();
    await expect(xhrUpload({ url: 'http://fixture/items', headers: {}, body: new FormData(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(sent).toBe(0);
  });

  it.each(['multipart', 'url'] as const)('%s取令牌期间取消，令牌返回后也不能发请求', async kind => {
    const controller = new AbortController();
    let release!: (value: string) => void;
    let requests = 0;
    const token = new Promise<string>(resolve => { release = resolve; });
    const api = new ApiClient({ baseUrl: 'http://fixture', getToken: () => token, upload: async () => { requests++; return { status: 200, body: '{"jobs":[]}' }; }, fetch: async () => { requests++; return new Response('{"jobs":[]}'); } });
    const run = kind === 'multipart' ? api.uploadFile('b1', new Blob(['x']), 'a.png', undefined, controller.signal) : api.addUrls('b1', ['https://image.example/a.png'], controller.signal);
    controller.abort();
    release('token');
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toBe(0);
  });
});
