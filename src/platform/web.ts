import type { LiteAdapter, SourceFile } from '../core/lite/types';
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
    cleanup: async () => undefined
  };
}
//#endregion
