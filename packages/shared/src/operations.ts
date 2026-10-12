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

/** 第一阶段只开放 download；overwrite、object-storage 后续支持 */
export interface OutputDestination {
  type: 'download' | 'overwrite' | 'object-storage';
  profileId?: string;
  objectKeyTemplate?: string;
}

export type ProcessingPolicy = 'private-local' | 'cloud';
