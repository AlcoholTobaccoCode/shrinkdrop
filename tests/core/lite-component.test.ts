import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

describe('browser preview screen', () => {
  let server: ViteDevServer;
  let html: string;
  beforeAll(async () => {
    server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
    const { default: App } = await server.ssrLoadModule('/src/App.vue');
    html = await renderToString(createSSRApp(App));
  });
  afterAll(async () => { await server?.close(); });

  it('states the desktop requirement and uploading privacy before any file is selected', () => {
    expect(html).toContain('当前为浏览器预览');
    expect(html).toContain('请使用桌面版');
    expect(html).toContain('图片会上传至 TinyPNG');
    expect(html).not.toContain('AVIF');
  });
  it('renders file import affordances but disables compression and saving in preview', () => {
    expect(html).toContain('添加图片'); expect(html).toContain('添加文件夹');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*开始压缩/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?保存全部/);
    expect(html).toContain('拖入图片');
  });
  it('renders an opt-in upload switch and the explicit overwrite privacy copy', () => {
    expect(html).toContain('上传自动压缩');
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(html).toContain('批量覆盖');
    expect(html).toContain('除非手动覆盖，原图不会被修改');
  });
  it('renders both faces with a tab switch and the share desktop requirement', () => {
    expect(html).toContain('shrink<span>drop</span>');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="face-tab-share"');
    expect(html).toContain('aria-controls="face-share"');
    expect(html).toContain('局域网分享需要桌面版');
    expect(html).toContain('选择文件');
    expect(html).toContain('停止分享后链接立即失效');
  });
});
