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

export interface SshSession {
  adapter: SshAdapter;
  state: {
    loaded: boolean;
    busy: boolean;
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

  async function run(action: () => Promise<SshOutcome>) {
    state.busy = true;
    state.detail = '';
    try {
      apply(await action());
    } catch (error) {
      state.error = 'internal';
      state.detail = typeof error === 'string' ? error : '';
    } finally {
      state.busy = false;
    }
  }

  const enable = (lifetime: SshLifetime, port: number) => run(() => adapter.enable(lifetime, port));
  const disable = () => run(() => adapter.disable());
  const setLifetime = (lifetime: SshLifetime) => run(() => adapter.setLifetime(lifetime));
  const setPort = (port: number) => run(() => adapter.setPort(port));
  const installHelper = () => run(() => adapter.installHelper());
  const uninstallHelper = () => run(() => adapter.uninstallHelper());

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
    uninstallHelper,
    subscribe
  };
}
