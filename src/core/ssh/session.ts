import { reactive } from 'vue';
import {
  defaultSshRuntime,
  defaultSshSettings,
  type SshAdapter,
  type SshErrorCode,
  type SshLifetime,
  type SshOutcome,
  type SshRuntime,
  type SshSettingsView
} from './types';

/** 正在执行的耗时操作；UI 用它显示“在做什么 + 已等多久”。 */
export type SshAction = 'install' | 'uninstall' | 'enable' | 'disable' | 'port';

export interface SshSession {
  adapter: SshAdapter;
  state: {
    loaded: boolean;
    busy: boolean;
    action: SshAction | null;
    /** 当前操作已等待的秒数，由 1s 定时器推进。 */
    elapsed: number;
    runtime: SshRuntime;
    settings: SshSettingsView;
    error: SshErrorCode | null;
    detail: string;
  };
  load(): Promise<SshRuntime>;
  enable(lifetime: SshLifetime, port: number): Promise<void>;
  disable(): Promise<void>;
  setLifetime(lifetime: SshLifetime): Promise<void>;
  setPort(port: number): Promise<void>;
  installHelper(): Promise<void>;
  openSharingSettings(): Promise<void>;
  installBundledOpenSsh(): Promise<void>;
  openOpenSshDownload(): Promise<void>;
  uninstallHelper(): Promise<void>;
  subscribe(): Promise<() => void>;
}

/**
 * 远程访问的会话状态：运行态来自后端探测，期望状态只由 `ssh_*` 命令写入。
 * 通用 `settings_update` 不携带 ssh 字段，两者不会互相覆盖。
 */
export function createSshSession(adapter: SshAdapter): SshSession {
  const state = reactive({
    loaded: false,
    busy: false,
    action: null as SshAction | null,
    elapsed: 0,
    runtime: defaultSshRuntime(),
    settings: defaultSshSettings(),
    error: null as SshErrorCode | null,
    /** 后端返回的可读错误（例如端口校验失败），不来自 helper 的原始输出。 */
    detail: ''
  });

  function apply(outcome: SshOutcome) {
    state.runtime = outcome.runtime;
    state.settings = outcome.ssh;
    state.error = outcome.error ?? outcome.runtime.error;
  }

  /** 1s 心跳：装服务要等 UAC + 服务启动，最多 30s，没有反馈就是“干等”。 */
  function startTicker() {
    state.elapsed = 0;
    const started = Date.now();
    const timer = setInterval(() => {
      state.elapsed = Math.floor((Date.now() - started) / 1000);
    }, 1000);
    return () => clearInterval(timer);
  }

  async function load() {
    try {
      const snapshot = await adapter.status();
      state.runtime = snapshot.runtime;
      state.settings = snapshot.ssh;
      state.error = snapshot.runtime.error;
    } catch {
      state.error = 'internal';
    } finally {
      state.loaded = true;
    }
    return state.runtime;
  }

  async function run(kind: SshAction | null, action: () => Promise<SshOutcome>) {
    state.busy = true;
    state.action = kind;
    state.detail = '';
    const stop = kind ? startTicker() : () => {};
    try {
      apply(await action());
    } catch (error) {
      state.error = 'internal';
      state.detail = typeof error === 'string' ? error : '';
    } finally {
      stop();
      state.busy = false;
      state.action = null;
    }
  }

  const enable = (lifetime: SshLifetime, port: number) =>
    run('enable', () => adapter.enable(lifetime, port));
  const disable = () => run('disable', () => adapter.disable());
  const setLifetime = (lifetime: SshLifetime) => run(null, () => adapter.setLifetime(lifetime));
  const setPort = (port: number) => run('port', () => adapter.setPort(port));
  const installHelper = () => run('install', () => adapter.installHelper());
  async function openSharingSettings() {
    try {
      await adapter.openSharingSettings();
    } catch (error) {
      state.detail = typeof error === 'string' ? error : '';
    }
  }
  const installBundledOpenSsh = () => run('install', () => adapter.installBundledOpenSsh());
  async function openOpenSshDownload() {
    try {
      await adapter.openOpenSshDownload();
    } catch (error) {
      state.detail = typeof error === 'string' ? error : '';
    }
  }
  const uninstallHelper = () => run('uninstall', () => adapter.uninstallHelper());

  /** 主窗口改了 SSH 状态时，设置窗口跟随刷新。 */
  async function subscribe() {
    return adapter.onStatus(runtime => {
      state.runtime = runtime;
      state.error = runtime.error;
    });
  }

  return {
    adapter,
    state,
    load,
    enable,
    disable,
    setLifetime,
    setPort,
    installHelper,
    installBundledOpenSsh,
    openOpenSshDownload,
    uninstallHelper,
    openSharingSettings,
    subscribe
  };
}
