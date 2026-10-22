export type StartFace = 'last' | 'compress' | 'share';
export type Face = 'compress' | 'share';
export type Language = 'auto' | 'zh' | 'en';
export type Protection = 'link' | 'pin' | 'accounts';

export interface Permissions {
  download: boolean;
  upload: boolean;
  text: boolean;
}

export interface AccountView {
  id: string;
  username: string;
  password: string;
  permissions: Permissions;
  enabled: boolean;
}

export interface GroupView {
  id: string;
  name: string;
  slug: string;
  public: boolean;
  protection: Protection;
  pinSet: boolean;
  allowUpload: boolean;
  allowText: boolean;
}

export interface GroupAccessPatch {
  public: boolean;
  protection: Protection;
  allowUpload: boolean;
  allowText: boolean;
}

export interface SettingsView {
  general: { startFace: StartFace; lastFace: Face; language: Language };
  compression: { autoCompress: boolean; concurrency: number; saveDir: string | null };
  share: {
    port: number;
    uploadDir: string | null;
    protection: Protection;
    public: boolean;
    pinSet: boolean;
    allowUpload: boolean;
    allowText: boolean;
    accounts: AccountView[];
    groups: GroupView[];
  };
}

export interface SettingsMutation {
  settings: SettingsView;
  shareRestarted: boolean;
}

export interface SettingsUpdatePayload {
  general: SettingsView['general'];
  compression: SettingsView['compression'];
  share: {
    port: number;
    uploadDir: string | null;
    protection: Protection;
    public: boolean;
    allowUpload: boolean;
    allowText: boolean;
  };
}

export type SettingsEvent = 'changed' | 'toast';

export interface SettingsAdapter {
  desktop: boolean;
  open(): Promise<void>;
  onEvent(handler: (event: SettingsEvent, payload?: string) => void): Promise<() => void>;
  get(): Promise<SettingsView>;
  update(payload: SettingsUpdatePayload): Promise<SettingsMutation>;
  touchFace(face: Face): Promise<void>;
  pickDirectory(): Promise<string | null>;
  setPin(pin: string | null): Promise<SettingsMutation>;
  addAccount(username: string, password: string, permissions: Permissions): Promise<SettingsMutation>;
  updateAccount(
    id: string,
    patch: { enabled?: boolean; permissions?: Permissions; password?: string }
  ): Promise<SettingsMutation>;
  deleteAccount(id: string): Promise<SettingsMutation>;
  addGroup(name: string, slug: string | null): Promise<SettingsMutation>;
  updateGroup(id: string, name: string, slug: string): Promise<SettingsMutation>;
  deleteGroup(id: string): Promise<SettingsMutation>;
  updateGroupAccess(id: string, patch: GroupAccessPatch): Promise<SettingsMutation>;
  setGroupPin(id: string, pin: string | null): Promise<SettingsMutation>;
}

export function defaultSettings(): SettingsView {
  return {
    general: { startFace: 'last', lastFace: 'compress', language: 'auto' },
    compression: { autoCompress: false, concurrency: 5, saveDir: null },
    share: {
      port: 5421,
      uploadDir: null,
      protection: 'link',
      public: false,
      pinSet: false,
      allowUpload: false,
      allowText: false,
      accounts: [],
      groups: []
    }
  };
}
