/** SSH 远程访问的前端契约：运行态由后端探测，期望状态由 ssh_* 命令持久化。 */

export type SshLifetime = 'app' | 'persistent';

export type SshErrorCode =
  | 'unsupported_os'
  | 'unsupported_custom_port'
  | 'needs_admin'
  | 'helper_unavailable'
  | 'helper_version_mismatch'
  | 'feature_missing'
  | 'service_missing'
  | 'service_start_failed'
  | 'service_stop_failed'
  | 'firewall_blocked'
  | 'policy_blocked'
  | 'port_in_use'
  | 'busy'
  | 'read_only'
  | 'internal'
  | 'unsupported_verb'
  | 'frame_too_large'
  | 'timeout';

export interface SshPortOwner {
  port: number;
  pid: number;
  process: string;
}

export interface SshRuntime {
  supported: boolean;
  platform: 'macos' | 'windows' | 'other';
  admin: boolean;
  /** 本构建是否包含可用的控制面后端；false 时开关与安装入口都不显示。 */
  backendAvailable: boolean;
  /** 只读模式：开关不可用，只能引导用户去系统设置（macOS 未签名路线）。 */
  readOnly: boolean;
  /** 三态：unknown 不能当作“已开启”。 */
  osState: 'enabled' | 'disabled' | 'unknown';
  username: string;
  helperInstalled: boolean;
  helperApproved: boolean;
  osEnabled: boolean;
  owned: boolean;
  listening: boolean;
  address: string | null;
  port: number;
  installSource: 'system' | 'fod' | 'bundled';
  bundledVersion: string | null;
  fingerprint: string | null;
  portInUse: SshPortOwner | null;
  error: SshErrorCode | null;
  /** 错误的具体原因（哪一步失败、Win32 错误码），UI 用作可诊断的第二行。 */
  errorDetail: string | null;
}

export interface SshSettingsView {
  enabled: boolean;
  lifetime: SshLifetime;
  port: number;
}

/** `ssh_status` 的完整读取：真实现状 + 持久化的期望状态。 */
export interface SshSnapshot {
  runtime: SshRuntime;
  ssh: SshSettingsView;
}

export interface SshOutcome {
  runtime: SshRuntime;
  ssh: SshSettingsView;
  error: SshErrorCode | null;
}

export interface SshAdapter {
  status(): Promise<SshSnapshot>;
  enable(lifetime: SshLifetime, port: number): Promise<SshOutcome>;
  disable(): Promise<SshOutcome>;
  setLifetime(lifetime: SshLifetime): Promise<SshOutcome>;
  setPort(port: number): Promise<SshOutcome>;
  installHelper(): Promise<SshOutcome>;
  /** 只读路线：打开系统设置 → 共享。 */
  openSharingSettings(): Promise<void>;
  /** Windows FoD 失败时的兜底：安装随包固定版 OpenSSH。 */
  installBundledOpenSsh(): Promise<SshOutcome>;
  /** FoD 失败时打开 OpenSSH 官方发布页；URL 固定在后端。 */
  openOpenSshDownload(): Promise<void>;
  uninstallHelper(): Promise<SshOutcome>;
  onStatus(handler: (runtime: SshRuntime) => void): Promise<() => void>;
}

export function defaultSshRuntime(): SshRuntime {
  return {
    supported: false,
    platform: 'other',
    admin: false,
    backendAvailable: false,
    readOnly: false,
    osState: 'disabled',
    username: '',
    helperInstalled: false,
    helperApproved: false,
    osEnabled: false,
    owned: false,
    listening: false,
    address: null,
    port: 22,
    installSource: 'system',
    bundledVersion: null,
    fingerprint: null,
    portInUse: null,
    error: null,
    errorDetail: null
  };
}

export function defaultSshSettings(): SshSettingsView {
  return { enabled: false, lifetime: 'app', port: 22 };
}
