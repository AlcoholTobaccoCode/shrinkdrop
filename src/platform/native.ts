import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { BulkOverwriteResult, BulkSaveResult, CompressionResult, LiteAdapter, ProgressEvent, SourceFile } from '../core/lite/types';
import type { ShareAdapter, ShareStatus } from '../core/share/types';
import type { Face, GroupAccessPatch, Permissions, SettingsAdapter, SettingsMutation, SettingsUpdatePayload, SettingsView } from '../core/settings/types';

export type NativeInvoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;

//#region 原生文件与压缩接口
export function createNativeAdapter(invoke: NativeInvoke = tauriInvoke): LiteAdapter {
  return {
    desktop: true,
    chooseFiles: () => invoke<SourceFile[]>('choose_files'),
    chooseDirectory: () => invoke<SourceFile[]>('choose_directory'),
    readFile: async source => Uint8Array.from(await invoke<number[]>('read_file', { sourceId: source.id })),
    compress: (sourceId, taskId) => invoke<CompressionResult>('compress_image', { sourceId, taskId }),
    cancel: taskId => invoke<void>('cancel_compression', { taskId }),
    save: (tempFileId, suggestedName) => invoke<{ saved: boolean }>('save_temp_file', { tempFileId, suggestedName }),
    saveResults: tempFileIds => invoke<BulkSaveResult>('save_results', { tempFileIds }),
    overwrite: tempFileId => invoke<{ overwritten: boolean }>('overwrite_temp_file', { tempFileId }),
    overwriteResults: tempFileIds => invoke<BulkOverwriteResult>('overwrite_results', { tempFileIds }),
    cleanup: sessionId => invoke<void>('cleanup_temp_files', { sessionId })
  };
}
//#endregion

//#region 桌面事件
export async function connectDesktopEvents(handlers: {
  imported: (files: SourceFile[]) => void;
  progress: (progress: ProgressEvent) => void;
  drag: (active: boolean) => void;
}): Promise<() => void> {
  const [{ listen }, { getCurrentWebviewWindow }] = await Promise.all([
    import('@tauri-apps/api/event'), import('@tauri-apps/api/webviewWindow')
  ]);
  const unlisten: Array<() => void> = [];
  try {
    unlisten.push(await listen<SourceFile[]>('lite-files-imported', event => handlers.imported(event.payload)));
    unlisten.push(await listen<ProgressEvent>('lite-progress', event => handlers.progress(event.payload)));
    unlisten.push(await getCurrentWebviewWindow().onDragDropEvent(event => {
      // 拖入的路径由原生端登记，页面只接收已登记的文件描述和拖拽状态。
      handlers.drag(event.payload.type === 'enter' || event.payload.type === 'over');
    }));
    return () => unlisten.forEach(stop => stop());
  } catch (error) { unlisten.forEach(stop => stop()); throw error; }
}
//#endregion

//#region 局域网分享接口
export function createNativeShareAdapter(invoke: NativeInvoke = tauriInvoke): ShareAdapter {
  return {
    desktop: true,
    status: () => invoke<ShareStatus>('share_status'),
    start: paths => invoke<ShareStatus>('share_start', { paths }),
    stop: () => invoke<ShareStatus>('share_stop'),
    addItems: paths => invoke<ShareStatus>('share_add_items', { paths }),
    removeItem: id => invoke<ShareStatus>('share_remove_item', { id }),
    pickFiles: () => invoke<string[]>('share_pick_files'),
    pickDirectory: () => invoke<string[]>('share_pick_directory'),
    qrSvg: url => invoke<string>('share_qr_svg', { url }),
    addText: (text: string) => invoke<void>('share_add_text', { text }),
    setActiveGroup: (id: string) => invoke<ShareStatus>('share_set_active_group', { groupId: id }),
    openUploadDir: () => invoke<void>('share_open_upload_dir'),
    addPaths: (paths: string[]) => invoke<ShareStatus>('share_add_items', { paths }),
    saveItems: (ids: number[]) => invoke<boolean>('share_save_items', { ids }),
    onStatus: async handler => {
      const { listen } = await import('@tauri-apps/api/event');
      const stopStatus = await listen<ShareStatus>('share-status', event => handler(event.payload));
      const stopRefresh = await listen('share-refresh', async () => {
        try {
          handler(await invoke<ShareStatus>('share_status'));
        } catch {
          // 状态刷新失败时保留旧数据。
        }
      });
      return () => {
        stopStatus();
        stopRefresh();
      };
    },
    setTitle: title => invoke<void>('share_set_title', { title })
  };
}
//#endregion

//#region 设置接口
export function createNativeSettingsAdapter(invoke: NativeInvoke = tauriInvoke): SettingsAdapter {
  return {
    desktop: true,
    open: () => invoke<void>('settings_open'),
    onEvent: async handler => {
      const { listen } = await import('@tauri-apps/api/event');
      const stops = [
        await listen('settings-changed', () => handler('changed')),
        await listen<string>('settings-toast', event => handler('toast', event.payload))
      ];
      return () => stops.forEach(stop => stop());
    },
    get: () => invoke<SettingsView>('settings_get'),
    update: (payload: SettingsUpdatePayload) => invoke<SettingsMutation>('settings_update', { update: payload }),
    touchFace: (face: Face) => invoke<void>('settings_touch_face', { face }),
    pickDirectory: () => invoke<string | null>('settings_pick_directory'),
    setPin: (pin: string | null) => invoke<SettingsMutation>('share_set_pin', { pin }),
    addAccount: (username: string, password: string, permissions: Permissions) =>
      invoke<SettingsMutation>('share_add_account', { username, password, permissions }),
    updateAccount: (id: string, patch: { enabled?: boolean; permissions?: Permissions; password?: string }) =>
      invoke<SettingsMutation>('share_update_account', { id, ...patch }),
    deleteAccount: (id: string) => invoke<SettingsMutation>('share_delete_account', { id }),
    addGroup: (name: string, slug: string | null) => invoke<SettingsMutation>('share_group_add', { name, slug }),
    updateGroup: (id: string, name: string, slug: string) => invoke<SettingsMutation>('share_group_update', { id, name, slug }),
    deleteGroup: (id: string) => invoke<SettingsMutation>('share_group_delete', { id }),
    updateGroupAccess: (id: string, patch: GroupAccessPatch) =>
      invoke<SettingsMutation>('share_group_access', { id, ...patch }),
    setGroupPin: (id: string, pin: string | null) =>
      invoke<SettingsMutation>('share_group_set_pin', { id, pin })
  };
}
//#endregion

export async function connectShareDrops(handler: (paths: string[]) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<string[]>('share-paths-dropped', event => handler(event.payload));
}
