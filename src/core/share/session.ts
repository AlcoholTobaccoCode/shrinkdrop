import { computed, reactive } from 'vue';
import type { ShareAdapter, ShareItem, ShareStatus } from './types';

export type SharePhase = 'idle' | 'starting' | 'running' | 'stopping';

/**
 * 分享面会话：负责起停、文件增删、二维码与复制，不直接触碰 DOM 之外的平台能力。
 * 所有状态变更都走 apply(status)，事件推送与命令返回保持同一份数据来源。
 */
export function createShareSession(adapter: ShareAdapter) {
  const state = reactive({
    phase: 'idle' as SharePhase,
    items: [] as ShareItem[],
    url: '',
    addresses: [] as string[],
    warning: '',
    error: '',
    qr: '',
    qrError: false,
    adding: false,
    copied: false
  });

  const running = computed(() => state.phase === 'running');
  const busy = computed(() => state.phase === 'starting' || state.phase === 'stopping');
  const totalSize = computed(() => state.items.reduce((total, item) => total + (item.kind === 'file' ? item.size : 0), 0));
  const port = computed(() => {
    const matched = state.url.match(/:(\d+)\/s\//);
    return matched ? Number(matched[1]) : null;
  });

  let qrFor = '';
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  function errorText(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
  }

  async function loadQr(url: string) {
    if (!adapter.desktop || qrFor === url) return;
    qrFor = url;
    state.qrError = false;
    try {
      const svg = await adapter.qrSvg(url);
      if (qrFor === url) state.qr = svg;
    } catch {
      if (qrFor === url) {
        state.qr = '';
        state.qrError = true;
      }
      qrFor = '';
    }
  }

  function apply(status: ShareStatus) {
    state.items = status.items ?? [];
    state.url = status.url ?? '';
    state.addresses = status.addresses ?? [];
    state.warning = status.warning ?? '';
    state.phase = status.running ? 'running' : 'idle';
    if (!status.running) {
      state.qr = '';
      state.qrError = false;
      qrFor = '';
    } else if (state.url) {
      void loadQr(state.url);
    }
  }

  async function refresh() {
    if (!adapter.desktop) return;
    try {
      apply(await adapter.status());
    } catch {
      // 启动时读不到状态就保持未开始，不打扰用户。
    }
  }

  /** 订阅原生状态事件，返回取消订阅函数。 */
  async function connect(): Promise<() => void> {
    if (!adapter.desktop) return () => {};
    try {
      const stop = await adapter.onStatus(apply);
      await refresh();
      return stop;
    } catch {
      return () => {};
    }
  }

  async function pickAndStart(pick: () => Promise<string[]>) {
    if (!adapter.desktop || busy.value) return;
    state.error = '';
    state.phase = 'starting';
    try {
      const paths = await pick();
      if (!paths.length) {
        state.phase = 'idle';
        return;
      }
      apply(await adapter.start(paths));
    } catch (error) {
      state.phase = 'idle';
      state.error = errorText(error, '开始分享失败，请重试');
    }
  }

  function pickAndShare() {
    return pickAndStart(() => adapter.pickFiles());
  }

  function pickAndShareFolder() {
    return pickAndStart(() => adapter.pickDirectory());
  }

  async function addPaths(pick: () => Promise<string[]>, fallback: string) {
    if (!adapter.desktop || !running.value || state.adding) return;
    state.error = '';
    state.adding = true;
    try {
      const paths = await pick();
      if (!paths.length) return;
      apply(await adapter.addItems(paths));
    } catch (error) {
      state.error = errorText(error, fallback);
    } finally {
      state.adding = false;
    }
  }

  function addFiles() {
    return addPaths(() => adapter.pickFiles(), '添加文件失败，请重试');
  }

  function addFolder() {
    return addPaths(() => adapter.pickDirectory(), '添加文件夹失败，请重试');
  }

  async function remove(id: number) {
    if (!running.value) return;
    state.error = '';
    try {
      apply(await adapter.removeItem(id));
    } catch (error) {
      state.error = errorText(error, '移除文件失败，请重试');
    }
  }

  async function stop() {
    if (!adapter.desktop || !running.value || busy.value) return;
    state.error = '';
    state.phase = 'stopping';
    try {
      apply(await adapter.stop());
    } catch (error) {
      state.phase = 'running';
      state.error = errorText(error, '停止分享失败，请重试');
    }
  }

  function markCopied() {
    state.copied = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { state.copied = false; }, 1600);
  }

  function fallbackCopy(text: string): boolean {
    if (typeof document === 'undefined') return false;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }

  async function copy() {
    if (!state.url) return;
    state.error = '';
    try {
      await navigator.clipboard.writeText(state.url);
      markCopied();
    } catch {
      if (fallbackCopy(state.url)) markCopied();
      else state.error = '复制失败，请手动选择链接';
    }
  }

  function dispose() {
    if (copiedTimer) clearTimeout(copiedTimer);
  }

  return { state, running, busy, totalSize, port, connect, refresh, pickAndShare, pickAndShareFolder, addFiles, addFolder, remove, stop, copy, dispose };
}
