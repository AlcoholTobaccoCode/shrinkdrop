import type { FileAdapter } from '../core/files/contracts';
import { WebFileAdapter } from './web';

export type PlatformName = 'tauri' | 'web';

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function currentPlatform(): PlatformName {
  return isTauriRuntime() ? 'tauri' : 'web';
}

export async function createPlatformAdapters(): Promise<FileAdapter> {
  if (isTauriRuntime()) {
    const { createTauriFileAdapter } = await import('./tauri/file-adapter');
    return createTauriFileAdapter();
  }
  return new WebFileAdapter();
}
