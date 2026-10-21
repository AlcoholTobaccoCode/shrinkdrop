import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { BulkOverwriteResult, BulkSaveResult, CompressionResult, LiteAdapter, ProgressEvent, SourceFile } from '../core/lite/types';

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
