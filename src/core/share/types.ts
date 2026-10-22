export type ShareKind = 'file' | 'dir' | 'text';

export interface ShareItem {
  id: number;
  kind: ShareKind;
  name: string;
  size: number;
  modified: number | null;
  text: string | null;
}

export interface ShareGroup {
  id: string;
  name: string;
  slug: string;
  url: string;
  items: ShareItem[];
}

export interface ShareStatus {
  running: boolean;
  url: string | null;
  port: number | null;
  items: ShareItem[];
  addresses: string[];
  ipv6Addresses: string[];
  warning: string | null;
  activeGroup: string;
  groups: ShareGroup[];
}

export interface ShareAdapter {
  desktop: boolean;
  status(): Promise<ShareStatus>;
  start(paths: string[]): Promise<ShareStatus>;
  stop(): Promise<ShareStatus>;
  addItems(paths: string[]): Promise<ShareStatus>;
  removeItem(id: number): Promise<ShareStatus>;
  addText(text: string): Promise<void>;
  setActiveGroup(id: string): Promise<ShareStatus>;
  openUploadDir(): Promise<void>;
  pickFiles(): Promise<string[]>;
  pickDirectory(): Promise<string[]>;
  qrSvg(url: string): Promise<string>;
  onStatus(handler: (status: ShareStatus) => void): Promise<() => void>;
  setTitle(title: string): Promise<void>;
}

export function emptyShareStatus(): ShareStatus {
  return { running: false, url: null, port: null, items: [], addresses: [], ipv6Addresses: [], warning: null, activeGroup: '', groups: [] };
}
