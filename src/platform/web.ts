import type { LiteAdapter, SourceFile } from '../core/lite/types';
import type { ShareAdapter } from '../core/share/types';
import type { SettingsAdapter, SettingsMutation, SettingsUpdatePayload } from '../core/settings/types';
import { defaultSettings } from '../core/settings/types';
import { emptyShareStatus } from '../core/share/types';
import { createUUID } from '../core/lite/id';

//#region 浏览器文件预览
export function fromBrowserFiles(files: File[]): SourceFile[] {
  return files.map(file => ({
    id: createUUID(), name: file.name, size: file.size, mime: file.type,
    relativePath: file.webkitRelativePath || file.name, lastModified: file.lastModified, handle: file
  }));
}

function chooseFiles(directory: boolean): Promise<SourceFile[]> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true;
    input.accept = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
    if (directory) input.setAttribute('webkitdirectory', '');
    let done = false;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true; clearTimeout(cancelTimer); window.removeEventListener('focus', onFocus);
      resolve(fromBrowserFiles(Array.from(input.files ?? []))); input.remove();
    };
    const onFocus = () => { cancelTimer = setTimeout(finish, 1000); };
    input.addEventListener('change', finish, { once: true });
    input.addEventListener('cancel', finish, { once: true });
    window.addEventListener('focus', onFocus, { once: true });
    input.hidden = true; document.body.append(input); input.click();
  });
}

export function createBrowserAdapter(): LiteAdapter {
  const desktopRequired = async (): Promise<never> => { throw new Error('请使用桌面版压缩和保存图片。'); };
  return {
    desktop: false,
    chooseFiles: () => chooseFiles(false), chooseDirectory: () => chooseFiles(true),
    readFile: async source => {
      if (!(source.handle instanceof File)) throw new Error('无法预览图片');
      return new Uint8Array(await source.handle.arrayBuffer());
    },
    compress: desktopRequired, cancel: desktopRequired,
    save: desktopRequired, saveResults: desktopRequired,
    overwrite: desktopRequired, overwriteResults: desktopRequired,
    cleanup: async () => undefined
  };
}
//#endregion

//#region 浏览器预览的分享占位
export function createBrowserShareAdapter(): ShareAdapter {
  const desktopRequired = async (): Promise<never> => { throw new Error('局域网分享需要桌面版。'); };
  return {
    desktop: false,
    status: async () => emptyShareStatus(),
    start: desktopRequired,
    stop: async () => emptyShareStatus(),
    addItems: desktopRequired,
    removeItem: desktopRequired,
    pickFiles: desktopRequired,
    pickDirectory: desktopRequired,
    qrSvg: desktopRequired,
    onStatus: async () => () => {},
    setTitle: async title => { if (typeof document !== 'undefined') document.title = title; }
  };
}
//#endregion

//#region 浏览器预览的设置占位
export function createBrowserSettingsAdapter(): SettingsAdapter {
  let current = defaultSettings();
  const result = (): SettingsMutation => ({ settings: current, shareRestarted: false });
  return {
    desktop: false,
    get: async () => current,
    update: async (payload: SettingsUpdatePayload) => {
      current = {
        ...current,
        general: payload.general,
        compression: payload.compression,
        share: { ...current.share, ...payload.share }
      };
      return result();
    },
    touchFace: async face => {
      current = { ...current, general: { ...current.general, lastFace: face } };
    },
    pickDirectory: async () => null,
    setPin: async pin => {
      current = { ...current, share: { ...current.share, pinSet: Boolean(pin) } };
      return result();
    },
    addAccount: async (username, _password, permissions) => {
      current = {
        ...current,
        share: {
          ...current.share,
          accounts: [
            ...current.share.accounts,
            { id: `preview-${username}`, username, permissions, enabled: true }
          ]
        }
      };
      return result();
    },
    updateAccount: async (id, patch) => {
      current = {
        ...current,
        share: {
          ...current.share,
          accounts: current.share.accounts.map(account =>
            account.id === id
              ? {
                  ...account,
                  enabled: patch.enabled ?? account.enabled,
                  permissions: patch.permissions ?? account.permissions
                }
              : account
          )
        }
      };
      return result();
    },
    deleteAccount: async id => {
      current = {
        ...current,
        share: { ...current.share, accounts: current.share.accounts.filter(account => account.id !== id) }
      };
      return result();
    }
  };
}
//#endregion
