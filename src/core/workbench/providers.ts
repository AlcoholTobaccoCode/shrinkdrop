import type { ImageProviderManifest, Operation, ProviderId } from '@tinypng/shared';

/** 本地 Provider 能力（第 5 条：压缩、PNG/JPG/WebP 转换、缩放；不支持 URL） */
export const LOCAL_MANIFEST: ImageProviderManifest = {
  id: 'local',
  label: '本地私有',
  processing: 'local',
  capabilities: {
    compress: true,
    convert: ['png', 'jpeg', 'webp'],
    resize: true,
    smartResize: false,
    crop: false,
    smartCrop: false,
    metadata: [],
    urlInput: false,
    storageOutput: false
  }
};

export interface OperationConflict {
  index: number;
  operation: Operation;
  reason: string;
  /** 匿名线路冲突时建议改用官方 */
  suggestProviderId?: ProviderId;
}

export function isOperationSupported(manifest: ImageProviderManifest, op: Operation): boolean {
  const c = manifest.capabilities;
  switch (op.type) {
    case 'compress': return c.compress;
    case 'convert': return c.convert.includes(op.format);
    case 'resize': return c.resize;
    case 'smart-resize': return c.smartResize;
    case 'crop': return c.crop;
    case 'smart-crop': return c.smartCrop;
    case 'metadata': return op.preserve.every(field => c.metadata.includes(field));
  }
}

/** 不自动切换线路，只返回冲突给 UI 提示（第 6 条） */
export function findConflicts(manifest: ImageProviderManifest, operations: readonly Operation[]): OperationConflict[] {
  return operations.flatMap((operation, index) => {
    if (isOperationSupported(manifest, operation)) return [];
    return [{
      index,
      operation,
      reason: manifest.label + ' 不支持该操作',
      suggestProviderId: manifest.id === 'anonymous-tinify' ? 'official-tinify' : undefined
    }];
  });
}
