export interface ShareFile {
  id: number;
  name: string;
  size: number;
  url: string;
}

export interface ShareStatus {
  running: boolean;
  url: string | null;
  port: number | null;
  files: ShareFile[];
  addresses: string[];
  warning: string | null;
}

export interface ShareAdapter {
  desktop: boolean;
  status(): Promise<ShareStatus>;
  start(paths: string[]): Promise<ShareStatus>;
  stop(): Promise<ShareStatus>;
  addFiles(paths: string[]): Promise<ShareStatus>;
  removeFile(id: number): Promise<ShareStatus>;
  pickFiles(): Promise<string[]>;
  qrSvg(url: string): Promise<string>;
  onStatus(handler: (status: ShareStatus) => void): Promise<() => void>;
  setTitle(title: string): Promise<void>;
}

export function emptyShareStatus(): ShareStatus {
  return { running: false, url: null, port: null, files: [], addresses: [], warning: null };
}
