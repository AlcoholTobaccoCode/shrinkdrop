export interface SourceFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  relativePath: string;
  lastModified?: number;
  handle?: unknown;
}

export interface TempFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  relativePath: string;
  handle?: unknown;
}

export interface FileAdapter {
  chooseFiles(): Promise<SourceFile[]>;
  chooseDirectory(): Promise<SourceFile[]>;
  read(file: SourceFile): Promise<Uint8Array>;
  writeTemp(taskId: string, bytes: Uint8Array, extension: string, mime: string): Promise<TempFile>;
  copyToClipboard(files: TempFile[]): Promise<void>;
  replaceOriginal(temp: TempFile, source: SourceFile): Promise<void>;
  cleanup(sessionId: string): Promise<void>;
}
