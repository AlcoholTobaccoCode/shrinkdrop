import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { compileScript, parse } from 'vue/compiler-sfc';
import { createRenderer, h, nextTick, reactive, type Component } from 'vue';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import type { WorkbenchItem } from '../../src/core/workbench/model';
import { queueItemView } from '../../src/core/workbench/queue-view';

const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve('vite'));
const { build } = await import(pathToFileURL(viteRequire.resolve('esbuild')).href);

// 直接编译真实 Vue SFC，在内存渲染器中验状态；不启动浏览器或外网服务。
const temporary = mkdtempSync(resolve('tests/core/.component-recovery-'));
const mounted: Array<() => void> = [];
afterEach(() => { mounted.splice(0).forEach(unmount => unmount()); });
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

async function loadComponent(name: string): Promise<Component> {
  const filename = resolve('src/components/workbench', name + '.vue');
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
  const script = compileScript(descriptor, { id: name, inlineTemplate: true, genDefaultAs: '__component' });
  const output = await build({ stdin: { contents: script.content + '\nexport default __component;', resolveDir: dirname(filename), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', external: ['vue'], plugins: [{
    name: 'headless-reka', setup(builder: { onResolve: (options: object, callback: () => object) => void; onLoad: (options: object, callback: () => object) => void }) {
      builder.onResolve({ filter: /^reka-ui$/ }, () => ({ path: 'reka-ui', namespace: 'headless-reka' }));
      // 只替换第三方DOM原语；真实SFC的按钮、watch、状态计算和事件处理全部执行。
      builder.onLoad({ filter: /.*/, namespace: 'headless-reka' }, () => ({ contents: 'import {defineComponent,h} from "vue"; const primitive=defineComponent({inheritAttrs:false,setup(_,{attrs,slots}){return()=>h("div",attrs,slots.default?.({open:false}));}}); export const CollapsibleRoot=primitive,CollapsibleContent=primitive,CollapsibleTrigger=primitive,SliderRoot=primitive,SliderTrack=primitive,SliderThumb=primitive,ToggleGroupRoot=primitive,ToggleGroupItem=primitive;', loader: 'js' }));
    }
  }] });
  const path = join(temporary, name + '.mjs');
  writeFileSync(path, output.outputFiles[0]!.text);
  return (await import(pathToFileURL(path).href)).default as Component;
}

interface Node { tag: string; text: string; props: Record<string, unknown>; children: Node[]; parent?: Node }
const node = (tag: string, text = ''): Node => ({ tag, text, props: {}, children: [] });
const renderer = createRenderer<Node, Node>({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (element, text) => { element.text = text; }, setElementText: (element, text) => { element.text = text; element.children = []; },
  patchProp: (element, key, _previous, value) => { element.props[key] = value; },
  insert: (element, parent, anchor) => { element.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; if (at < 0) parent.children.push(element); else parent.children.splice(at, 0, element); },
  remove: element => { const parent = element.parent; if (parent) parent.children.splice(parent.children.indexOf(element), 1); },
  parentNode: element => element.parent ?? null, nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] ?? null,
  insertStaticContent: (content, parent) => { const element = node('#static', content); element.parent = parent; parent.children.push(element); return [element, element]; }
});
function all(root: Node): Node[] { return [root, ...root.children.flatMap(all)]; }
function text(root: Node): string { return root.text + root.children.map(text).join(''); }
function mount(component: Component, props: Record<string, unknown>): Node {
  const root = node('root');
  const app = renderer.createApp({ render: () => h(component, props) });
  app.mount(root);
  mounted.push(() => app.unmount());
  return root;
}
const item: WorkbenchItem = { id: 'u1', batchId: 'b1', mode: 'cloud', source: { kind: 'url', url: 'https://images.example/a.png' }, status: 'completed', progress: 1, attempts: 1, originalSize: 0, compressedSize: 5, output: { bytes: new Uint8Array(0), size: 5, mime: 'image/png', width: 640, height: 320, ratio: 0.5 }, outputs: [{ outputId: 'o1', destination: { type: 'download' }, status: 'completed' }] };

describe('真实组件恢复行为', () => {
  it('URL无原图blob时以结果尺寸显示完整结果，不产生0px画布', async () => {
    const component = await loadComponent('CompareCanvas');
    const root = mount(component, { item, resultUrl: 'blob:result' });
    await nextTick();
    const result = all(root).find(element => element.tag === 'img' && element.props.src === 'blob:result');
    expect(result).toBeDefined();
    expect(result!.parent?.props.style).toMatchObject({ width: '640px', height: '320px' });
    expect(text(root)).toContain('原图不可预览');
  });

  it.each(['completed', 'failed', 'canceled'] as const)('取消等待期间状态变%s时清除取消中，终态操作可以继续', async status => {
    const component = await loadComponent('QueueRow');
    const running = reactive({ ...item, status: 'processing' as WorkbenchItem['status'], output: undefined, compressedSize: undefined });
    let resolveCancel!: () => void;
    const pending = new Promise<void>(resolve => { resolveCancel = resolve; });
    const props = reactive({ item: running, view: queueItemView(running), onAction: () => pending });
    const root = mount(component, props);
    const cancel = all(root).find(element => element.tag === 'button' && String(element.props['aria-label']).startsWith('取消 '));
    expect(cancel).toBeDefined();
    const click = cancel!.props.onClick as () => Promise<void>;
    const action = click();
    await nextTick();
    expect(text(root)).toContain('取消中…');
    running.status = status;
    props.view = queueItemView(running);
    resolveCancel();
    await action;
    await nextTick();
    expect(text(root)).not.toContain('取消中…');
    expect(text(root)).toContain(props.view.text);
  });
});
