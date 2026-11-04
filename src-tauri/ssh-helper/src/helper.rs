//! helper 的业务核心：把固定动词翻译成系统动作。
//!
//! 与平台无关（所有副作用都经 `Runner` / `ConfigIo` / `StateIo`），因此可以在任意
//! 平台上用假实现跑单测；Windows 服务外壳与命名管道在 `main.rs` / `pipe.rs`。

use std::sync::{Arc, Mutex};

use shrinkdrop_ssh_core::{
    ErrorCode, HelperStatus, InstallSource, OsState, SshLifetime, StateFile,
};

/// helper 内部的失败类型：协议层的 `HelperError` 属于 core crate，这里不能给它
/// 实现 `From`，所以用本地类型，在 IPC 边界处转换。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub code: ErrorCode,
    pub detail: Option<String>,
}

impl Failure {
    pub fn new(code: ErrorCode) -> Self {
        Self { code, detail: None }
    }

    pub fn with_detail(code: ErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: Some(detail.into()),
        }
    }

    pub fn to_helper_error(&self) -> shrinkdrop_ssh_core::HelperError {
        shrinkdrop_ssh_core::HelperError {
            code: self.code,
            detail: self.detail.clone(),
        }
    }
}

impl From<ErrorCode> for Failure {
    fn from(code: ErrorCode) -> Self {
        Failure::new(code)
    }
}

use crate::config::{self, ConfigIo};
use crate::runner::Runner;
use crate::sshd::{self, ServiceState, SshdControl, StartType};
use crate::state::{self, StateIo};

/// 一个客户端会话的引用计数；归零后按生命周期决定是否关闭。
#[derive(Default)]
struct Sessions {
    count: u32,
}

pub struct Helper {
    runner: Arc<dyn Runner>,
    config_io: Arc<dyn ConfigIo>,
    state_io: Arc<dyn StateIo>,
    config_path: String,
    state_path: String,
    /// 随包 MSI 路径（由进程启动参数决定，不由 IPC 传入）。
    bundled_msi: Option<String>,
    sessions: Mutex<Sessions>,
    state: Mutex<StateFile>,
}

impl Helper {
    pub fn new(
        runner: Arc<dyn Runner>,
        config_io: Arc<dyn ConfigIo>,
        state_io: Arc<dyn StateIo>,
        config_path: impl Into<String>,
        state_path: impl Into<String>,
    ) -> Self {
        let state_path = state_path.into();
        let state = state::load(state_io.as_ref(), &state_path);
        Self {
            runner,
            config_io,
            state_io,
            config_path: config_path.into(),
            state_path,
            bundled_msi: None,
            sessions: Mutex::new(Sessions::default()),
            state: Mutex::new(state),
        }
    }

    /// 由启动参数指定随包 MSI 的位置（安装器知道它在哪，IPC 不知道）。
    pub fn with_bundled_msi(mut self, path: impl Into<String>) -> Self {
        self.bundled_msi = Some(path.into());
        self
    }

    fn control(&self) -> SshdControl {
        SshdControl::new(self.runner.clone())
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, StateFile> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn persist(&self, state: &StateFile) -> Result<(), ErrorCode> {
        state::save(self.state_io.as_ref(), &self.state_path, state)
    }

    fn commit(&self, state: StateFile) -> Result<(), Failure> {
        *self.lock_state() = state.clone();
        self.persist(&state)?;
        Ok(())
    }

    /// 读系统真实状态 + 期望状态。
    pub fn status(&self) -> Result<HelperStatus, Failure> {
        let control = self.control();
        let service = control.service_state();
        if service == ServiceState::NotFound {
            return Err(Failure::new(ErrorCode::ServiceMissing));
        }
        let state = self.lock_state().clone();
        let port = state.port;
        let owner = control.port_owner(port);
        let listening = owner.is_some();
        let os_enabled = service == ServiceState::Running;

        let sshd_listening = owner
            .as_ref()
            .is_some_and(|value| value.process.eq_ignore_ascii_case("sshd.exe"));
        // 端口被别人占着时，不能宣称“SSH 已开启”。
        let os_state = if listening && !sshd_listening {
            OsState::Unknown
        } else if os_enabled {
            OsState::Enabled
        } else if service == ServiceState::Stopped {
            OsState::Disabled
        } else {
            OsState::Unknown
        };
        let port_in_use = if os_state == OsState::Unknown { owner } else { None };

        let install_source = if state.installed_by_app {
            InstallSource::Bundled
        } else {
            control.install_source()
        };
        Ok(HelperStatus {
            enabled: state.desired,
            os_enabled,
            os_state: Some(os_state),
            listening: listening && sshd_listening,
            port,
            owned: state.owned,
            lifetime: state.lifetime,
            install_source,
            bundled_version: self.bundled_version(),
            port_in_use,
            fingerprint: self.fingerprint(),
        })
    }

    /// 随包 MSI 版本（从文件名解析，不读文件内容）。
    fn bundled_version(&self) -> Option<String> {
        let name = std::path::Path::new(self.bundled_msi.as_deref()?).file_name()?.to_str()?;
        let rest = name.split("OpenSSH-Win64-v").nth(1)?;
        Some(rest.trim_end_matches(".msi").to_string())
    }

    /// 主机指纹：按 ed25519 → ecdsa → rsa 的顺序取第一个可用的公钥。
    fn fingerprint(&self) -> Option<String> {
        sshd::HOST_KEYS.iter().find_map(|path| {
            let output = self.runner.run("ssh-keygen.exe", &["-lf", path]).ok()?;
            if !output.success() {
                return None;
            }
            output
                .stdout
                .split_whitespace()
                .find(|token| token.starts_with("SHA256:"))
                .map(str::to_string)
        })
    }

    /// 端口预检：被其它进程占用就失败；被本机 sshd 占用按幂等处理。
    fn check_port_free(&self, port: u16) -> Result<(), Failure> {
        match self.control().port_owner(port) {
            Some(owner) if !owner.process.eq_ignore_ascii_case("sshd.exe") => {
                Err(Failure::with_detail(
                    ErrorCode::PortInUse,
                    format!("{} (PID {})", owner.process, owner.pid),
                ))
            }
            _ => Ok(()),
        }
    }

    pub fn enable(&self, lifetime: SshLifetime, port: u16) -> Result<HelperStatus, Failure> {
        if port == 0 {
            return Err(Failure::new(ErrorCode::UnsupportedCustomPort));
        }
        let control = self.control();
        if control.service_state() == ServiceState::NotFound {
            // 没有 sshd 时先装可选功能；失败由 UI 提供“官网下载 / 内置安装”。
            control.install_feature()?;
            if control.service_state() == ServiceState::NotFound {
                return Err(Failure::new(ErrorCode::FeatureMissing));
            }
        }
        self.check_port_free(port)?;

        let previous_start_type_kind = control.start_type();
        let previous_start_type = previous_start_type_kind.as_sc_value().to_string();
        let mut state = self.lock_state().clone();

        // 已开启：幂等，不重复操作，也不把别人的实例记成我们的。
        if control.service_state() == ServiceState::Running {
            state.desired = true;
            state.lifetime = lifetime;
            state.port = port;
            state.previous_start_type = Some(previous_start_type);
            // 已开着就不接管：`owned` 保持原值（我们之前开的是 true，别人的是 false）。
            self.commit(state)?;
            return self.status();
        }

        // 只在真的需要改端口时才动 sshd_config：默认端口 22 且配置本来就听 22 时
        // 不写文件、不留备份，避免为了“开启”而修改用户的系统配置。
        let content = self.read_config();
        let managed = config::managed_port(&content);
        if managed.is_some_and(|value| value != port)
            || (managed.is_none() && config::effective_port(&content) != port)
        {
            self.write_port(port)?;
        }
        // 启动前先确保防火墙放行，否则开了也连不上。
        control.ensure_firewall_rule(port, &format!("shrinkdrop-ssh-{port}"))?;
        // 启动类型必须在 start 之前改：被设为 Disabled 的服务起不来。
        let desired_start = match lifetime {
            SshLifetime::Persistent => StartType::Auto,
            SshLifetime::App => StartType::Demand,
        };
        control.set_start_type(desired_start)?;
        if let Err(error) = control.start() {
            let _ = control.set_start_type(previous_start_type_kind);
            return Err(Failure::new(error));
        }
        state::record_enable(&mut state, lifetime, port, &previous_start_type);
        self.commit(state.clone())?;

        // 起来之后确认端口真的在监听；失败就把这次开启记成错误并回滚服务。
        if control.port_owner(port).is_none() {
            let _ = control.stop();
            let _ = control.set_start_type(previous_start_type_kind);
            state::record_error(&mut state, ErrorCode::ServiceStartFailed);
            self.commit(state)?;
            return Err(Failure::new(ErrorCode::ServiceStartFailed));
        }
        self.status()
    }

    fn read_config(&self) -> String {
        self.config_io
            .read(&self.config_path)
            .unwrap_or_default()
    }

    fn write_port(&self, port: u16) -> Result<(), Failure> {
        let control = self.control();
        config::set_port(self.config_io.as_ref(), &self.config_path, port, || {
            control.validate_config()
        })
        .map_err(Failure::from)
    }

    pub fn disable(&self) -> Result<HelperStatus, Failure> {
        let control = self.control();
        let mut state = self.lock_state().clone();
        if !state.owned {
            // 用户手动开启的实例：只清期望状态，绝不关服务。
            state::record_disable(&mut state);
            self.commit(state)?;
            return self.status();
        }
        control.stop()?;
        let restore = state
            .previous_start_type
            .as_deref()
            .map(StartType::parse)
            .filter(|kind| *kind != StartType::Unknown)
            .unwrap_or(StartType::Demand);
        control.set_start_type(restore)?;
        control.remove_firewall_rule(&format!("shrinkdrop-ssh-{}", state.port));
        config::restore_backup(self.config_io.as_ref(), &self.config_path)
            .map_err(Failure::from)?;
        state::record_disable(&mut state);
        self.commit(state)?;
        self.status()
    }

    pub fn set_lifetime(&self, lifetime: SshLifetime) -> Result<HelperStatus, Failure> {
        let control = self.control();
        let mut state = self.lock_state().clone();
        state.lifetime = lifetime;
        if state.desired && state.owned {
            match lifetime {
                SshLifetime::Persistent => control.set_start_type(StartType::Auto)?,
                SshLifetime::App => control.set_start_type(StartType::Demand)?,
            }
        }
        self.commit(state)?;
        self.status()
    }

    pub fn set_port(&self, port: u16) -> Result<HelperStatus, Failure> {
        if port == 0 {
            return Err(Failure::new(ErrorCode::UnsupportedCustomPort));
        }
        self.check_port_free(port)?;
        let control = self.control();
        let mut state = self.lock_state().clone();
        if !state.desired {
            // 未开启时只持久化偏好。
            state.port = port;
            self.commit(state)?;
            return self.status();
        }
        let previous_port = state.port;
        self.write_port(port)?;
        control.ensure_firewall_rule(port, &format!("shrinkdrop-ssh-{port}"))?;
        control.stop()?;
        control.start()?;
        if control.port_owner(port).is_none() {
            // 端口没生效：恢复配置与旧端口。
            let _ = self.write_port(previous_port);
            return Err(Failure::new(ErrorCode::ServiceStartFailed));
        }
        if !control.port_released(previous_port) {
            // 新端口开着、旧端口还在：配置没真正替换，回滚避免两个端口都暴露。
            let _ = self.write_port(previous_port);
            let _ = control.stop();
            let _ = control.start();
            return Err(Failure::new(ErrorCode::ServiceStartFailed));
        }
        control.remove_firewall_rule(&format!("shrinkdrop-ssh-{previous_port}"));
        state.port = port;
        self.commit(state)?;
        self.status()
    }

    /// 客户端会话 +1；0→1 时把服务设为按需启动（`app` 生命周期）。
    pub fn attach(&self) -> Result<(), Failure> {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if sessions.count > 0 {
            sessions.count += 1;
            return Ok(());
        }
        let state = self.lock_state().clone();
        if state.desired && state.owned && state.lifetime == SshLifetime::App {
            self.control().set_start_type(StartType::Demand)?;
        }
        sessions.count = 1;
        Ok(())
    }

    /// 会话 -1；归零且 `owned && app` 时关闭 sshd。
    pub fn detach(&self) -> Result<(), Failure> {
        let remaining = {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if sessions.count == 0 {
                return Ok(());
            }
            sessions.count -= 1;
            sessions.count
        };
        if remaining > 0 {
            return Ok(());
        }
        self.close_owned_instance()
    }

    /// 心跳超时：与最后一个客户端 detach 等价。
    pub fn heartbeat_lost(&self) -> Result<(), Failure> {
        {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            sessions.count = 0;
        }
        self.close_owned_instance()
    }

    fn close_owned_instance(&self) -> Result<(), Failure> {
        let mut state = self.lock_state().clone();
        if !state::should_close_on_detach(&state) {
            return Ok(());
        }
        let control = self.control();
        control.stop()?;
        control.set_start_type(StartType::Demand)?;
        control.remove_firewall_rule(&format!("shrinkdrop-ssh-{}", state.port));
        state::record_disable(&mut state);
        self.commit(state)?;
        Ok(())
    }

    /// FoD 失败后的兜底：安装随包固定版 OpenSSH。
    ///
    /// 只在系统里还没有 sshd 时允许；安装完成后回到“关闭但已安装”的状态，
    /// 由 UI 再触发一次 enable。路径由 helper 自己定位，不接受调用方传路径。
    pub fn install_bundled(&self) -> Result<(), Failure> {
        let msi = self
            .bundled_msi
            .as_deref()
            .ok_or_else(|| Failure::with_detail(ErrorCode::FeatureMissing, "此版本未随包提供 OpenSSH"))?;
        self.control()
            .install_bundled(std::path::Path::new(msi))
            .map_err(Failure::from)?;
        let mut state = self.lock_state().clone();
        state.installed_by_app = true;
        self.commit(state)?;
        Ok(())
    }

    /// 卸载：关闭自己开的实例、还原配置与启动类型、删除自建防火墙规则。
    pub fn uninstall(&self) -> Result<(), Failure> {
        let state = self.lock_state().clone();
        if state.owned {
            let _ = self.disable();
        }
        config::restore_backup(self.config_io.as_ref(), &self.config_path)
            .map_err(Failure::from)?;
        self.control()
            .remove_firewall_rule(&format!("shrinkdrop-ssh-{}", state.port));
        let _ = self.state_io.write(&self.state_path, "");
        *self.lock_state() = StateFile::default();
        Ok(())
    }
}
