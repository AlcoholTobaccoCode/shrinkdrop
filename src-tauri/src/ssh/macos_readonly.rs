//! macOS 只读探测：不签名路线下，应用只报告系统 Remote Login 的真实状态。
//!
//! 没有 Developer ID 就没有 SMAppService helper，因此这里**不做任何写操作**：
//! 只读 `launchctl`、探测 22 端口、读 host key 指纹。开关交给系统设置。
//!
//! 判定必须是三态，不能把“没权限”或“端口被别的进程占着”当成“已开启”。

use std::io;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::process::Command;
use std::time::Duration;

use shrinkdrop_ssh_core::{ErrorCode, HelperStatus, InstallSource, OsState, SshLifetime};

use super::{HelperInfo, SshBackend, SshError};

/// 系统 sshd 的监听端口：stock Remote Login 由 launchd 的 socket 固定为 22。
pub const PROBE_PORT: u16 = 22;

/// 一次探测的原始结果，纯数据，便于用 fixture 测试判定规则。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Probe {
    /// `launchctl print` 的退出码为 0（job 已加载）。
    pub job_loaded: bool,
    /// `launchctl print` 明确报“找不到服务”，而不是权限错误。
    pub job_missing: bool,
    /// 22 端口有进程在监听。
    pub listening: bool,
    pub fingerprint: Option<String>,
}

impl Probe {
    pub fn os_state(&self) -> OsState {
        if self.job_loaded {
            OsState::Enabled
        } else if self.listening {
            // 端口开着但 job 没加载：可能是别的进程占用，不能宣称 SSH 已开启。
            OsState::Unknown
        } else if self.job_missing {
            OsState::Disabled
        } else {
            // 既没加载、又没明确“找不到”：多半是权限错误，无法确认。
            OsState::Unknown
        }
    }
}

/// `launchctl print` 的输出分类。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrintOutcome {
    Loaded,
    NotFound,
    Denied,
}

/// 解析 `launchctl print system/com.openssh.sshd` 的 stdout/stderr 与退出码。
pub fn classify_print(success: bool, stderr: &str) -> PrintOutcome {
    if success {
        return PrintOutcome::Loaded;
    }
    let text = stderr.to_lowercase();
    if text.contains("could not find service") || text.contains("not find service") {
        PrintOutcome::NotFound
    } else if text.contains("operation not permitted")
        || text.contains("permission denied")
        || text.contains("bad request")
    {
        PrintOutcome::Denied
    } else {
        // 其它未知错误按“无法确认”处理。
        PrintOutcome::Denied
    }
}

/// 从 `ssh-keygen -lf <pub>` 的输出里取 `SHA256:...` 指纹。
pub fn parse_fingerprint(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .find(|token| token.starts_with("SHA256:"))
        .map(str::to_string)
}

fn probe_port(port: u16) -> bool {
    let target = SocketAddr::from(([127, 0, 0, 1], port));
    match target.to_socket_addrs() {
        Ok(mut addresses) => addresses
            .next()
            .map(|address| TcpStream::connect_timeout(&address, Duration::from_millis(400)).is_ok())
            .unwrap_or(false),
        Err(_) => false,
    }
}

fn run_launchctl() -> (bool, String) {
    let output = Command::new("/bin/launchctl")
        .args(["print", "system/com.openssh.sshd"])
        .output();
    match output {
        Ok(output) => (output.status.success(), String::from_utf8_lossy(&output.stderr).into_owned()),
        Err(error) => (false, error.to_string()),
    }
}

fn run_ssh_keygen(path: &str) -> Option<String> {
    let output = Command::new("/usr/bin/ssh-keygen").args(["-lf", path]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_fingerprint(&String::from_utf8_lossy(&output.stdout))
}

/// 读取 host key 指纹；优先 ed25519，其次 ecdsa、rsa。
fn host_key_fingerprint() -> Option<String> {
    const KEYS: &[&str] = &[
        "/etc/ssh/ssh_host_ed25519_key.pub",
        "/etc/ssh/ssh_host_ecdsa_key.pub",
        "/etc/ssh/ssh_host_rsa_key.pub",
    ];
    KEYS.iter().find_map(|path| run_ssh_keygen(path))
}

/// 执行一次真实探测。
pub fn probe() -> Probe {
    let (success, stderr) = run_launchctl();
    let listening = probe_port(PROBE_PORT);
    let outcome = classify_print(success, &stderr);
    Probe {
        job_loaded: outcome == PrintOutcome::Loaded,
        job_missing: outcome == PrintOutcome::NotFound,
        listening,
        fingerprint: if success { host_key_fingerprint() } else { None },
    }
}

/// 只读后端：报告状态，拒绝一切写操作。
pub struct ReadOnlyBackend;

fn read_only_error() -> SshError {
    SshError::with_detail(
        ErrorCode::ReadOnly,
        "macOS 未签名构建：只能由系统设置管理 Remote Login",
    )
}

impl ReadOnlyBackend {
    fn status_from(probe: Probe) -> HelperStatus {
        let state = probe.os_state();
        HelperStatus {
            enabled: state == OsState::Enabled,
            os_enabled: state == OsState::Enabled,
            os_state: Some(state),
            listening: probe.listening,
            port: PROBE_PORT,
            owned: false,
            lifetime: SshLifetime::Persistent,
            install_source: InstallSource::System,
            bundled_version: None,
            // 只读路线不查监听者（没有特权、也没有 lsof 依赖），宁可不说，
            // 也不要编一个 `unknown (PID 0)` 让用户去追。
            port_in_use: None,
            fingerprint: probe.fingerprint,
        }
    }
}

impl SshBackend for ReadOnlyBackend {
    fn helper_info(&self) -> HelperInfo {
        HelperInfo {
            available: true,
            // 关键：可读但不可写。
            writable: false,
            installed: false,
            approved: false,
            version: None,
        }
    }

    fn status(&self) -> Result<HelperStatus, SshError> {
        Ok(Self::status_from(probe()))
    }

    fn enable(&self, _lifetime: SshLifetime, _port: u16) -> Result<HelperStatus, SshError> {
        Err(read_only_error())
    }

    fn disable(&self) -> Result<HelperStatus, SshError> {
        Err(read_only_error())
    }

    fn set_lifetime(&self, _lifetime: SshLifetime) -> Result<HelperStatus, SshError> {
        Err(read_only_error())
    }

    fn set_port(&self, _port: u16) -> Result<HelperStatus, SshError> {
        Err(read_only_error())
    }

    fn attach(&self) -> Result<(), SshError> {
        Err(read_only_error())
    }

    fn detach(&self) -> Result<(), SshError> {
        Ok(())
    }

    fn install_helper(&self) -> Result<(), SshError> {
        Err(read_only_error())
    }

    fn uninstall_helper(&self) -> Result<(), SshError> {
        Ok(())
    }
}

/// 打开系统设置里的“共享”面板；失败时由 UI 退回文字步骤。
pub fn open_sharing_settings() -> io::Result<()> {
    let deep_link = Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.Sharing-Settings.extension")
        .status();
    if deep_link.is_ok_and(|status| status.success()) {
        return Ok(());
    }
    let pane = Command::new("/usr/bin/open")
        .args(["-b", "com.apple.systempreferences"])
        .status()?;
    if pane.success() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::Other,
            "无法打开系统设置",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loaded_job_is_enabled() {
        let probe = Probe {
            job_loaded: true,
            job_missing: false,
            listening: true,
            fingerprint: None,
        };
        assert_eq!(probe.os_state(), OsState::Enabled);
    }

    #[test]
    fn open_port_without_job_is_unknown_not_enabled() {
        let probe = Probe {
            job_loaded: false,
            job_missing: true,
            listening: true,
            fingerprint: None,
        };
        assert_eq!(probe.os_state(), OsState::Unknown);
    }

    #[test]
    fn missing_job_and_closed_port_is_disabled() {
        let probe = Probe {
            job_loaded: false,
            job_missing: true,
            listening: false,
            fingerprint: None,
        };
        assert_eq!(probe.os_state(), OsState::Disabled);
    }

    #[test]
    fn permission_error_is_unknown() {
        let probe = Probe {
            job_loaded: false,
            job_missing: false,
            listening: false,
            fingerprint: None,
        };
        assert_eq!(probe.os_state(), OsState::Unknown);
    }

    #[test]
    fn print_outcome_is_classified_by_stderr() {
        assert_eq!(classify_print(true, ""), PrintOutcome::Loaded);
        assert_eq!(
            classify_print(
                false,
                "Could not find service \"com.openssh.sshd\" in domain for system"
            ),
            PrintOutcome::NotFound
        );
        assert_eq!(
            classify_print(false, "Bad request. Operation not permitted"),
            PrintOutcome::Denied
        );
    }

    #[test]
    fn fingerprint_is_extracted() {
        let output = "256 SHA256:AbCdEf1234567890 abc@host (ED25519)\n";
        assert_eq!(
            parse_fingerprint(output),
            Some("SHA256:AbCdEf1234567890".to_string())
        );
        assert_eq!(parse_fingerprint("not a key"), None);
    }

    #[test]
    fn read_only_backend_reports_writable_false_and_rejects_writes() {
        let backend = ReadOnlyBackend;
        let info = backend.helper_info();
        assert!(info.available);
        assert!(!info.writable);
        assert!(backend.enable(SshLifetime::App, 22).is_err());
        assert!(backend.disable().is_err());
        assert!(backend.set_port(2222).is_err());
        assert!(backend.install_helper().is_err());
    }

    /// 在真实系统上跑一次只读探测，验证三态自洽（不做任何写操作）。
    #[test]
    #[cfg(target_os = "macos")]
    fn real_probe_is_coherent_and_read_only() {
        let probe = probe();
        let state = probe.os_state();
        eprintln!(
            "probe: state={state:?} job_loaded={} job_missing={} listening={} fingerprint={:?}",
            probe.job_loaded, probe.job_missing, probe.listening, probe.fingerprint
        );
        match state {
            OsState::Enabled => assert!(probe.job_loaded, "已开启必须能读到 launchd job"),
            OsState::Disabled => {
                assert!(!probe.job_loaded);
                assert!(!probe.listening, "未开启却有人在 22 监听，三态应判成 unknown");
            }
            OsState::Unknown => assert!(!probe.job_loaded),
        }
        // 只读：探测不得产生 helper 或改动系统配置。
        assert!(ReadOnlyBackend.helper_info().available);
        assert!(!ReadOnlyBackend.helper_info().writable);
    }

    #[test]
    fn read_only_status_never_fabricates_a_port_owner() {
        let status = ReadOnlyBackend::status_from(Probe {
            job_loaded: false,
            job_missing: true,
            listening: true,
            fingerprint: None,
        });
        assert!(!status.os_enabled);
        assert_eq!(status.os_state, Some(OsState::Unknown));
        assert_eq!(status.port_in_use, None, "查不到监听者就不要编一个 PID 0");
    }
}
