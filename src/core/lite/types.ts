export interface SourceFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  relativePath: string;
  lastModified?: number;
  handle?: unknown;
}

export interface CompressionResult {
  tempFileId: string;
  size: number;
  mime: string;
  width: number;
  height: number;
  site: string;
}

export interface BulkSaveResult {
  saved: number;
  failed: Array<{ id: string; name: string; message: string }>;
  canceled: boolean;
}

export interface LiteAdapter {
  desktop: boolean;
  chooseFiles(): Promise<SourceFile[]>;
  chooseDirectory(): Promise<SourceFile[]>;
  readFile(source: SourceFile): Promise<Uint8Array>;
  compress(sourceId: string, taskId: string): Promise<CompressionResult>;
  cancel(taskId: string): Promise<void>;
  save(tempFileId: string, suggestedName: string): Promise<{ saved: boolean }>;
  saveResults(tempFileIds: string[]): Promise<BulkSaveResult>;
  cleanup(sessionId: string): Promise<void>;
}

export interface ProgressEvent { taskId: string; stage: 'uploading' | 'downloading' }
