import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { FileAdapter, SourceFile, TempFile } from '../../core/files/contracts';

export type TauriInvoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriFileDescriptor {
  id: string;
  name: string;
  size: number;
  mime: string;
  relativePath: string;
  lastModified?: number;
}

interface TauriTempDescriptor extends TauriFileDescriptor {
  handle?: string;
}

export interface TauriFileAdapterOptions {
  invoke?: TauriInvoke;
}

/**
 * Tauri 端文件适配器。
 *
 * 文件真实路径只在 Rust 状态中保存，渲染层只接触不可逆的文件 ID，避免路径进入
 * Vue 状态、日志或跨端共享核心。所有文件读写都经过自定义 command 和 capability。
 */
export function createTauriFileAdapter(options: TauriFileAdapterOptions = {}): FileAdapter {
  const invoke: TauriInvoke = options.invoke ?? tauriInvoke;

  return {
    async chooseFiles(): Promise<SourceFile[]> {
      const files = await invoke<TauriFileDescriptor[]>('choose_files');
      return files.map(toSourceFile);
    },

    async chooseDirectory(): Promise<SourceFile[]> {
      const files = await invoke<TauriFileDescriptor[]>('choose_directory');
      return files.map(toSourceFile);
    },

    async read(file: SourceFile): Promise<Uint8Array> {
      const bytes = await invoke<number[]>('read_file', { sourceId: file.id });
      return Uint8Array.from(bytes);
    },

    async writeTemp(taskId: string, bytes: Uint8Array, extension: string, mime: string): Promise<TempFile> {
      const result = await invoke<TauriTempDescriptor>('write_temp', {
        taskId,
        bytes: Array.from(bytes),
        extension: cleanExtension(extension),
        mime
      });
      return toTempFile(result);
    },

    async copyToClipboard(files: TempFile[]): Promise<void> {
      await invoke('copy_temp_files', {
        tempFileIds: files.map(file => handleId(file))
      });
    },

    async saveDownload(temp: TempFile, suggestedName: string): Promise<boolean> {
      const result = await invoke<{ saved: boolean }>('save_temp_file', {
        tempFileId: handleId(temp),
        suggestedName
      });
      return result.saved;
    },

    async replaceOriginal(temp: TempFile, source: SourceFile): Promise<void> {
      await invoke('replace_original', {
        tempFileId: handleId(temp),
        sourceId: source.id
      });
    },

    async cleanup(sessionId: string): Promise<void> {
      await invoke('cleanup_temp_files', { sessionId });
    }
  };
}

function toSourceFile(file: TauriFileDescriptor): SourceFile {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    mime: file.mime,
    relativePath: file.relativePath,
    ...(file.lastModified === undefined ? {} : { lastModified: file.lastModified })
  };
}

function toTempFile(file: TauriTempDescriptor): TempFile {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    mime: file.mime,
    relativePath: file.relativePath,
    handle: file.handle ?? file.id
  };
}

function handleId(file: TempFile): string {
  return typeof file.handle === 'string' && file.handle.length > 0 ? file.handle : file.id;
}

function cleanExtension(extension: string): string {
  const cleaned = extension.replace(/^\.+/, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (!cleaned) throw new Error('输出文件扩展名无效');
  return cleaned === 'jpeg' ? 'jpg' : cleaned;
}
