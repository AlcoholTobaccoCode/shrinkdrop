import type { FileAdapter } from '../core/files/contracts';
import { createPlatformAdapters } from './index';

let adapterPromise: Promise<FileAdapter> | undefined;

/** 全应用共享同一个 FileAdapter（Web 端 sources 表在实例上） */
export function getAdapter(): Promise<FileAdapter> {
  adapterPromise ??= createPlatformAdapters();
  return adapterPromise;
}
