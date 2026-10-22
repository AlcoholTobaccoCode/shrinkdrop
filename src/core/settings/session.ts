import { reactive } from 'vue';
import type {
  Face,
  Permissions,
  SettingsAdapter,
  SettingsMutation,
  SettingsUpdatePayload,
  SettingsView
} from './types';
import { defaultSettings } from './types';

function clone(view: SettingsView): SettingsView {
  return JSON.parse(JSON.stringify(view)) as SettingsView;
}

function payload(settings: SettingsView): SettingsUpdatePayload {
  return {
    general: settings.general,
    compression: settings.compression,
    share: {
      port: settings.share.port,
      uploadDir: settings.share.uploadDir,
      protection: settings.share.protection,
      allowUpload: settings.share.allowUpload,
      allowText: settings.share.allowText
    }
  };
}

export function createSettingsSession(adapter: SettingsAdapter) {
  const state = reactive({
    loaded: false,
    view: defaultSettings(),
    saving: false,
    error: '',
    toast: ''
  });

  function apply(result: SettingsMutation) {
    state.view = result.settings;
    if (result.shareRestarted) {
      state.toast = '分享已按新设置重启，旧链接已失效，请重新扫码。';
    }
  }

  function fail(error: unknown, fallback: string) {
    state.error = error instanceof Error && error.message ? error.message : fallback;
  }

  function open() {
    return adapter.open();
  }

  async function load() {
    if (!adapter.desktop) {
      state.loaded = true;
      return state.view;
    }
    try {
      state.view = await adapter.get();
    } catch {
      state.error = '读取设置失败，已使用默认值';
    } finally {
      state.loaded = true;
    }
    return state.view;
  }

  async function save(draft: SettingsView) {
    state.saving = true;
    state.error = '';
    try {
      apply(await adapter.update(payload(draft)));
    } catch (error) {
      fail(error, '保存设置失败，请重试');
    } finally {
      state.saving = false;
    }
  }

  /** 立即生效：修改本地副本后整份提交。 */
  async function update(mutator: (draft: SettingsView) => void) {
    const draft = clone(state.view);
    mutator(draft);
    state.view = draft;
    await save(draft);
  }

  async function touchFace(face: Face) {
    state.view.general.lastFace = face;
    try {
      await adapter.touchFace(face);
    } catch {
      // 记住上次面失败不影响使用。
    }
  }

  async function pickDirectory(kind: 'save' | 'upload') {
    try {
      const path = await adapter.pickDirectory();
      if (!path) return;
      await update(draft => {
        if (kind === 'save') draft.compression.saveDir = path;
        else draft.share.uploadDir = path;
      });
    } catch (error) {
      fail(error, '选择文件夹失败');
    }
  }

  async function mutate(action: () => Promise<SettingsMutation>, fallback: string) {
    state.saving = true;
    state.error = '';
    try {
      apply(await action());
    } catch (error) {
      fail(error, fallback);
    } finally {
      state.saving = false;
    }
  }

  function setPin(pin: string | null) {
    return mutate(() => adapter.setPin(pin), '保存 PIN 失败');
  }

  function addAccount(username: string, password: string, permissions: Permissions) {
    return mutate(() => adapter.addAccount(username, password, permissions), '添加账号失败');
  }

  function updateAccount(
    id: string,
    patch: { enabled?: boolean; permissions?: Permissions; password?: string }
  ) {
    return mutate(() => adapter.updateAccount(id, patch), '更新账号失败');
  }

  function deleteAccount(id: string) {
    return mutate(() => adapter.deleteAccount(id), '删除账号失败');
  }

  function dismissToast() {
    state.toast = '';
  }

  return {
    adapter,
    state,
    open,
    load,
    update,
    touchFace,
    pickDirectory,
    setPin,
    addAccount,
    updateAccount,
    deleteAccount,
    dismissToast
  };
}

export type SettingsSession = ReturnType<typeof createSettingsSession>;
