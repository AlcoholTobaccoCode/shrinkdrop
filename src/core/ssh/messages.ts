import type { SshErrorCode, SshRuntime } from './types';

/**
 * 错误码 → 中文原文（i18n 的 key）。UI 不展示 helper 的原始输出：
 * 里面可能有系统路径和命令行，既不可读也可能泄漏本机信息。
 */
export const sshErrorMessages: Record<SshErrorCode, string> = {
  unsupported_os: '当前系统版本不支持远程访问。',
  unsupported_custom_port: 'macOS 版只支持 22 端口。',
  needs_admin: '需要管理员账户才能开关远程访问。',
  helper_unavailable: '辅助服务未安装或不可用。',
  helper_version_mismatch: '辅助服务版本不匹配，需要更新。',
  feature_missing: '系统未安装 OpenSSH Server。',
  service_missing: '系统里没有 sshd 服务。',
  service_start_failed: '启动 sshd 失败。',
  service_stop_failed: '停止 sshd 失败。',
  firewall_blocked: '防火墙阻止了 SSH 端口。',
  policy_blocked: '系统策略禁止开启远程访问。',
  port_in_use: '端口已被其它进程占用。',
  busy: '上一个远程访问操作还没结束。',
  internal: '远程访问操作失败，请重试。',
  unsupported_verb: '辅助服务不支持该操作。',
  frame_too_large: '辅助服务返回的数据异常。',
  timeout: '辅助服务响应超时。'
};

/** `ssh user@ip`；非 22 端口带上 -p。 */
export function sshCommand(runtime: Pick<SshRuntime, 'address' | 'username' | 'port'>): string {
  const host = runtime.address || '127.0.0.1';
  const user = runtime.username || 'user';
  return runtime.port === 22
    ? `ssh ${user}@${host}`
    : `ssh -p ${runtime.port} ${user}@${host}`;
}
