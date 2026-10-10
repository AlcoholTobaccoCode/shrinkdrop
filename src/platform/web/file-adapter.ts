import type { FileAdapter, SourceFile, TempFile } from '../../core/files/contracts';
import { validateInputSize } from '../../core/compression/options';
import { defaultCompressionOptions } from '../../core/compression/types';

interface TempHandle {
  blob: Blob;
  url: string;
  sessionId: string;
}

export class WebFileAdapter implements FileAdapter {
  private readonly sources = new Map<string, File>();
  private readonly temps = new Map<string, TempHandle>();
  private nextId = 0;

  async chooseFiles(): Promise<SourceFile[]> {
    const input = this.createInput(false);
    return this.pickFromInput(input);
  }

  async chooseDirectory(): Promise<SourceFile[]> {
    const input = this.createInput(true);
    return this.pickFromInput(input);
  }

  fromFiles(files: readonly File[]): SourceFile[] {
    return files.flatMap(file => {
      if (!isSupportedFile(file)) return [];
      try {
        validateInputSize(file.size, defaultCompressionOptions);
      } catch {
        return [];
      }
      return [this.register(file)];
    });
  }

  async read(file: SourceFile): Promise<Uint8Array> {
    const source = this.sources.get(file.id);
    if (!source) throw new Error('文件已失效，请重新选择');
    return new Uint8Array(await source.arrayBuffer());
  }

  async writeTemp(taskId: string, bytes: Uint8Array, extension: string, mime: string): Promise<TempFile> {
    const sessionId = taskId;
    const blob = new Blob([toArrayBuffer(bytes)], { type: mime });
    const url = URL.createObjectURL(blob);
    const id = 'temp-' + String(++this.nextId);
    this.temps.set(id, { blob, url, sessionId });
    return {
      id,
      name: taskId + '.' + cleanExtension(extension),
      size: bytes.byteLength,
      mime,
      relativePath: taskId + '.' + cleanExtension(extension),
      handle: { blob, url, sessionId }
    };
  }

  async copyToClipboard(files: TempFile[]): Promise<void> {
    if (files.length !== 1) throw new Error('浏览器剪贴板一次只能复制一张图片');
    const handle = this.temps.get(files[0]?.id ?? '');
    if (!handle || !navigator.clipboard || typeof ClipboardItem === 'undefined') {
      throw new Error('当前浏览器不支持图片剪贴板，请使用下载');
    }
    await navigator.clipboard.write([new ClipboardItem({ [handle.blob.type]: handle.blob })]);
  }

  async replaceOriginal(): Promise<void> {
    throw new Error('Web 端无法覆盖本地原图，请下载压缩结果');
  }

  async cleanup(sessionId: string): Promise<void> {
    for (const [id, handle] of this.temps) {
      if (handle.sessionId === sessionId || handle.sessionId.startsWith(sessionId + '-')) {
        URL.revokeObjectURL(handle.url);
        this.temps.delete(id);
      }
    }
  }

  download(file: TempFile): void {
    const handle = this.temps.get(file.id);
    if (!handle) throw new Error('压缩结果已清理，请重新压缩');
    const anchor = document.createElement('a');
    anchor.href = handle.url;
    anchor.download = file.name;
    anchor.click();
  }

  private createInput(directory: boolean): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.multiple = true;
    if (directory) input.setAttribute('webkitdirectory', '');
    return input;
  }

  private pickFromInput(input: HTMLInputElement): Promise<SourceFile[]> {
    return new Promise(resolve => {
      input.style.display = 'none';
      document.body.append(input);
      input.addEventListener('change', () => {
        const files = this.fromFiles(Array.from(input.files ?? []));
        input.remove();
        resolve(files);
      }, { once: true });
      input.click();
    });
  }

  private register(file: File): SourceFile {
    const id = 'source-' + String(++this.nextId);
    this.sources.set(id, file);
    return {
      id,
      name: file.name,
      size: file.size,
      mime: normalizeMime(file.type, file.name),
      relativePath: file.webkitRelativePath || file.name,
      lastModified: file.lastModified,
      handle: file
    };
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function isSupportedFile(file: File): boolean {
  return isSupportedMime(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name);
}

function isSupportedMime(mime: string): boolean {
  return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp';
}

function normalizeMime(mime: string, name: string): string {
  if (isSupportedMime(mime)) return mime;
  if (/\.webp$/i.test(name)) return 'image/webp';
  if (/\.png$/i.test(name)) return 'image/png';
  return 'image/jpeg';
}

function cleanExtension(extension: string): string {
  const cleaned = extension.replace(/^\.+/, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (!cleaned) throw new Error('输出文件扩展名无效');
  return cleaned === 'jpeg' ? 'jpg' : cleaned;
}
