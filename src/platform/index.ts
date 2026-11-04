import { createNativeAdapter, createNativeSettingsAdapter, createNativeShareAdapter, createNativeSshAdapter } from './native';
import { createBrowserAdapter, createBrowserSettingsAdapter, createBrowserShareAdapter, createBrowserSshAdapter } from './web';

export function isTauriRuntime(scope: unknown = globalThis): boolean {
  return typeof scope === 'object' && scope !== null && '__TAURI_INTERNALS__' in scope;
}

export function createLiteAdapter() {
  return isTauriRuntime() ? createNativeAdapter() : createBrowserAdapter();
}

export function createShareAdapter() {
  return isTauriRuntime() ? createNativeShareAdapter() : createBrowserShareAdapter();
}

export function createSshAdapter() {
  return isTauriRuntime() ? createNativeSshAdapter() : createBrowserSshAdapter();
}

export function createSettingsAdapter() {
  return isTauriRuntime() ? createNativeSettingsAdapter() : createBrowserSettingsAdapter();
}
