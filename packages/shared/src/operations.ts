export type ImageFormat = 'avif' | 'webp' | 'jpeg' | 'png';
export type MetadataField = 'copyright' | 'gps' | 'creation-date';

export type Operation =
  | { type: 'compress'; quality?: number }
  | { type: 'convert'; format: ImageFormat }
  | { type: 'resize'; width?: number; height?: number; fit: 'contain' | 'cover' | 'inside' }
  | { type: 'smart-resize'; width: number; height: number; focus?: 'auto' | 'center' }
  | { type: 'crop'; width: number; height: number; x?: number; y?: number }
  | { type: 'smart-crop'; width: number; height: number }
  | { type: 'metadata'; preserve: MetadataField[] };

export type OperationType = Operation['type'];

/**
 * 第一阶段 Server 只接受 type: 'download'；
 * 'overwrite' 和 'object-storage' 会返回 422 VALIDATION_FAILED，后续阶段开放。
 */
export interface OutputDestination {
  type: 'download' | 'overwrite' | 'object-storage';
  profileId?: string;
  objectKeyTemplate?: string;
}

export type ProcessingPolicy = 'private-local' | 'cloud';

/** 第一阶段允许的输出目的地类型 */
export const PHASE1_DESTINATION_TYPES: ReadonlyArray<OutputDestination['type']> = ['download'];
