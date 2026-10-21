import { createNativeAdapter, createNativeShareAdapter } from './native';
import { createBrowserAdapter, createBrowserShareAdapter } from './web';

export function isTauriRuntime(scope: unknown = globalThis): boolean {
  return typeof scope === 'object' && scope !== null && '__TAURI_INTERNALS__' in scope;
}

export function createLiteAdapter() {
  return isTauriRuntime() ? createNativeAdapter() : createBrowserAdapter();
}

export function createShareAdapter() {
  return isTauriRuntime() ? createNativeShareAdapter() : createBrowserShareAdapter();
}
