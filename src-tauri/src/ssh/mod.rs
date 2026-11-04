//! SSH 远程访问：设置模型、状态机、命令与后端抽象。
//!
//! 设计见 `docs/ssh/plan.md`（方案 A：系统 sshd + 特权 helper）。
//! 本模块只做控制面：不托管 sshd 进程，不保存凭据。
//! 特权操作全部经 `SshBackend`；默认后端在 helper 不可用时只返回 `helper_unavailable`。

use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use shrinkdrop_ssh_core::{
    ErrorCode, HelperError, HelperStatus, InstallSource, PortOwner, SshLifetime,
};

use crate::settings::{self, SettingsState};

pub mod platform;

use platform::Platform;

#[cfg(target_os = "macos")]
mod macos_readonly;
mod ipc;
mod unavailable;
#[cfg(target_os = "windows")]
mod windows_pipe;

pub const DEFAULT_PORT: u16 = 22;
/// macOS 的 stock Remote Login 端口由 launchd 的 socket 决定，v1 只支持 22。
pub const MACOS_PORT: u16 = 22;

/// 持久化在 settings.json 的 SSH 期望状态。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SshSettings {
    pub enabled: bool,
    pub lifetime: SshLifetime,
    pub port: u16,
}

impl Default for SshSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            lifetime: SshLifetime::App,
            port: DEFAULT_PORT,
        }
    }
}

impl SshSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.port == 0 {
            return Err("SSH 端口需要在 1 到 65535 之间".to_string());
        }
        Ok(())
    }

    /// macOS 上永远按 22 处理：即使设置文件来自 Windows，也不去改系统监听端口。
    fn effective_port(&self, platform: Platform) -> u16 {
        match platform {
            Platform::MacOs => MACOS_PORT,
            Platform::Windows => self.port,
            Platform::Other => self.port,
        }
    }
}

/// helper 的安装/授权状态；由后端查询，不持久化。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HelperInfo {
    /// 本构建是否包含可用的 SSH 控制面后端；false 时开关与安装入口都不该出现。
    pub available: bool,
    /// 能否执行写操作（开关/生命周期/端口）。未签名路线的 macOS 只能读。
    pub writable: bool,
    pub installed: bool,
    pub approved: bool,
    pub version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshError {
    pub code: ErrorCode,
    pub detail: Option<String>,
}

impl SshError {
    pub fn new(code: ErrorCode) -> Self {
        Self { code, detail: None }
    }

    pub fn with_detail(code: ErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: Some(detail.into()),
        }
    }
}

impl From<HelperError> for SshError {
    fn from(error: HelperError) -> Self {
        Self {
            code: error.code,
            detail: error.detail,
        }
    }
}

/// 平台特权后端。实现者不能暴露任意命令：只接受固定动作与受控参数。
pub trait SshBackend: Send + Sync {
    fn helper_info(&self) -> HelperInfo;
    fn status(&self) -> Result<HelperStatus, SshError>;
    fn enable(&self, lifetime: SshLifetime, port: u16) -> Result<HelperStatus, SshError>;
    fn disable(&self) -> Result<HelperStatus, SshError>;
    fn set_lifetime(&self, lifetime: SshLifetime) -> Result<HelperStatus, SshError>;
    fn set_port(&self, port: u16) -> Result<HelperStatus, SshError>;
    /// 保持一个 helper 会话，用于 `lifetime=app` 的引用计数与心跳。
    fn attach(&self) -> Result<(), SshError>;
    fn detach(&self) -> Result<(), SshError>;
    fn install_helper(&self) -> Result<(), SshError>;
    fn uninstall_helper(&self) -> Result<(), SshError>;
    /// FoD 失败时安装随包固定版 OpenSSH；默认实现表示该平台没有这条兜底。
    fn install_bundled(&self) -> Result<HelperStatus, SshError> {
        Err(SshError::with_detail(
            ErrorCode::UnsupportedOs,
            "此平台没有随包 OpenSSH",
        ))
    }
}

/// 展示给设置窗口的运行态，不持久化。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshRuntime {
    pub supported: bool,
    pub platform: &'static str,
    pub admin: bool,
    pub username: String,
    pub backend_available: bool,
    /// 只读模式：开关不可用，只能引导用户去系统设置（macOS 未签名路线）。
    pub read_only: bool,
    pub helper_installed: bool,
    pub helper_approved: bool,
    pub os_enabled: bool,
    /// 三态：enabled / disabled / unknown；unknown 不能当作“已开启”。
    pub os_state: &'static str,
    pub owned: bool,
    pub listening: bool,
    pub address: Option<String>,
    pub port: u16,
    pub install_source: InstallSource,
    pub bundled_version: Option<String>,
    pub fingerprint: Option<String>,
    pub port_in_use: Option<PortOwner>,
    pub error: Option<ErrorCode>,
}

impl SshRuntime {
    fn new(platform: Platform, supported: bool, port: u16) -> Self {
        Self {
            supported,
            platform: platform.as_str(),
            admin: platform::is_admin(),
            username: username(),
            backend_available: false,
            read_only: false,
            helper_installed: false,
            helper_approved: false,
            os_enabled: false,
            os_state: "disabled",
            owned: false,
            listening: false,
            address: None,
            port,
            install_source: InstallSource::System,
            bundled_version: None,
            fingerprint: None,
            port_in_use: None,
            error: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Disabled,
    Enabling,
    Enabled,
    Disabling,
}

struct Inner {
    platform: Platform,
    supported: bool,
    backend: Arc<dyn SshBackend>,
    phase: Phase,
    settings: SshSettings,
    runtime: SshRuntime,
    /// attach 的引用计数：只有 0→1 才开会话，1→0 才 detach。
    clients: u32,
}

impl Inner {
    fn refresh(&mut self) {
        let platform = self.platform;
        let helper = self.backend.helper_info();
        self.runtime.supported = self.supported;
        self.runtime.platform = platform.as_str();
        self.runtime.username = username();
        self.runtime.backend_available = helper.available;
        self.runtime.read_only = helper.available && !helper.writable;
        self.runtime.helper_installed = helper.installed;
        self.runtime.helper_approved = helper.approved;
        self.runtime.bundled_version = helper.version.clone();
        self.runtime.port = self.settings.effective_port(platform);
        self.runtime.address = crate::share::net::candidate_addresses().into_iter().next();
        match self.backend.status() {
            Ok(status) => self.apply_status(status),
            Err(error) => {
                // helper 不可用时保留设置里的期望端口，系统状态未知按关闭处理。
                self.runtime.os_enabled = false;
                self.runtime.listening = false;
                self.runtime.owned = false;
                self.runtime.port_in_use = None;
                self.runtime.error = Some(error.code);
            }
        }
        self.sync_phase();
    }

    fn apply_status(&mut self, status: HelperStatus) {
        self.runtime.os_enabled = status.os_enabled;
        self.runtime.os_state = match status.os_state {
            Some(state) => state.as_str(),
            None if status.os_enabled => "enabled",
            None => "disabled",
        };
        self.runtime.listening = status.listening;
        self.runtime.owned = status.owned;
        self.runtime.port = status.port;
        self.runtime.install_source = status.install_source;
        self.runtime.port_in_use = status.port_in_use;
        self.runtime.fingerprint = status.fingerprint;
        self.runtime.error = None;
    }

    fn sync_phase(&mut self) {
        self.phase = match (self.phase, self.runtime.os_enabled) {
            (Phase::Enabling | Phase::Disabling, _) => self.phase,
            (_, true) => Phase::Enabled,
            (_, false) => Phase::Disabled,
        };
    }

    fn busy(&mut self) -> SshRuntime {
        self.runtime.error = Some(ErrorCode::Busy);
        self.runtime.clone()
    }

    fn record(&mut self, error: SshError) {
        eprintln!("ssh: {:?} {}", error.code, error.detail.unwrap_or_default());
    }

    fn attach(&mut self) -> Result<(), ErrorCode> {
        if self.clients > 0 {
            self.clients += 1;
            return Ok(());
        }
        match self.backend.attach() {
            Ok(()) => {
                self.clients = 1;
                Ok(())
            }
            Err(error) => {
                self.record(error.clone());
                self.runtime.error = Some(error.code);
                Err(error.code)
            }
        }
    }

    fn detach(&mut self) {
        if self.clients == 0 {
            return;
        }
        self.clients -= 1;
        if self.clients == 0 {
            if let Err(error) = self.backend.detach() {
                self.runtime.error = Some(error.code);
            }
        }
    }
}

/// SSH 控制面。内部状态共享，可跨线程克隆给阻塞任务使用。
#[derive(Clone)]
pub struct SshManager {
    inner: Arc<Mutex<Inner>>,
}

impl Default for SshManager {
    fn default() -> Self {
        let platform = Platform::current();
        let settings = SshSettings::default();
        Self::new(default_backend(platform), platform, settings)
    }
}

/// 未签名路线的默认后端：
/// - macOS：只读探测（没有 Developer ID 就无法注册 SMAppService helper）；
/// - Windows：签名可选，helper 是独立服务（T5）；
/// - 其它平台：没有控制面。
fn default_backend(platform: Platform) -> Arc<dyn SshBackend> {
    match platform {
        #[cfg(target_os = "macos")]
        Platform::MacOs => Arc::new(macos_readonly::ReadOnlyBackend),
        #[cfg(target_os = "windows")]
        Platform::Windows => Arc::new(ipc::TransportBackend::new(Box::new(
            windows_pipe::WindowsPipeTransport::locate(None),
        ))),
        _ => Arc::new(unavailable::UnavailableBackend),
    }
}

impl SshManager {
    pub fn new(backend: Arc<dyn SshBackend>, platform: Platform, settings: SshSettings) -> Self {
        let supported = platform.supported();
        Self::with_capabilities(backend, platform, supported, settings)
    }

    pub fn with_capabilities(
        backend: Arc<dyn SshBackend>,
        platform: Platform,
        supported: bool,
        settings: SshSettings,
    ) -> Self {
        let mut settings = settings;
        // macOS 的 stock Remote Login 只能监听 22：历史设置里的自定义端口在这里归一，
        // 而不是把它带进运行态或写回系统。
        settings.port = settings.effective_port(platform);
        let runtime = SshRuntime::new(platform, supported, settings.port);
        Self {
            inner: Arc::new(Mutex::new(Inner {
                platform,
                supported,
                backend,
                phase: Phase::Disabled,
                settings,
                runtime,
                clients: 0,
            })),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn runtime(&self) -> SshRuntime {
        self.lock().runtime.clone()
    }

    pub fn desired(&self) -> SshSettings {
        self.lock().settings.clone()
    }

    /// 启动对齐：读系统状态；已开启且 `lifetime=app` 时建立 helper 会话。
    /// 不覆盖用户手动开启的状态，也不在启动阶段弹授权。
    pub fn reconcile(&self, settings: SshSettings) {
        let mut inner = self.lock();
        inner.settings = settings;
        inner.refresh();
        if inner.settings.enabled
            && inner.settings.lifetime == SshLifetime::App
            && inner.runtime.helper_installed
            && inner.runtime.helper_approved
        {
            let _ = inner.attach();
        }
    }

    pub fn refresh(&self) -> SshRuntime {
        let mut inner = self.lock();
        inner.refresh();
        inner.runtime.clone()
    }

    pub fn enable(&self, lifetime: SshLifetime, port: u16) -> SshRuntime {
        let mut inner = self.lock();
        if !inner.supported {
            inner.runtime.error = Some(ErrorCode::UnsupportedOs);
            return inner.runtime.clone();
        }
        if inner.runtime.read_only {
            // 只读模式绝不写系统状态，也不写 enabled：开关由系统设置负责。
            inner.runtime.error = Some(ErrorCode::ReadOnly);
            return inner.runtime.clone();
        }
        if inner.platform == Platform::MacOs && port != MACOS_PORT {
            inner.runtime.error = Some(ErrorCode::UnsupportedCustomPort);
            return inner.runtime.clone();
        }
        if matches!(inner.phase, Phase::Enabling | Phase::Disabling) {
            return inner.busy();
        }
        // 先读系统状态，再决定是否接管。
        inner.refresh();
        // 已开启：不重复操作，也不把用户/其它工具的实例记成我们的。
        if inner.runtime.os_enabled {
            inner.settings.enabled = true;
            inner.settings.lifetime = lifetime;
            inner.refresh();
            return inner.runtime.clone();
        }
        inner.phase = Phase::Enabling;
        match inner.backend.enable(lifetime, port) {
            Ok(status) => {
                inner.phase = if status.os_enabled {
                    Phase::Enabled
                } else {
                    Phase::Disabled
                };
                inner.settings = SshSettings {
                    enabled: status.enabled || status.os_enabled,
                    lifetime: status.lifetime,
                    port: status.port,
                };
                inner.apply_status(status);
                if inner.settings.lifetime == SshLifetime::App {
                    // 没有会话就没有“退出即关”的保证；宁可回滚，也不留下退出后仍开着的大门。
                    if let Err(code) = inner.attach() {
                        let _ = inner.backend.disable();
                        inner.clients = 0;
                        inner.settings.enabled = false;
                        inner.phase = Phase::Disabled;
                        inner.refresh();
                        inner.runtime.error = Some(code);
                    }
                }
            }
            Err(error) => {
                inner.record(error.clone());
                inner.phase = Phase::Disabled;
                inner.refresh();
                inner.runtime.error = Some(error.code);
            }
        }
        inner.runtime.clone()
    }

    pub fn disable(&self) -> SshRuntime {
        let mut inner = self.lock();
        if inner.runtime.read_only {
            inner.runtime.error = Some(ErrorCode::ReadOnly);
            return inner.runtime.clone();
        }
        if matches!(inner.phase, Phase::Enabling | Phase::Disabling) {
            return inner.busy();
        }
        inner.refresh();
        if !inner.runtime.owned {
            // 不是应用开的实例：只清期望状态，绝不关系统服务。
            inner.settings.enabled = false;
            inner.refresh();
            return inner.runtime.clone();
        }
        inner.phase = Phase::Disabling;
        match inner.backend.disable() {
            Ok(status) => {
                inner.settings.enabled = false;
                inner.phase = if status.os_enabled {
                    Phase::Enabled
                } else {
                    Phase::Disabled
                };
                inner.apply_status(status);
                inner.detach();
            }
            Err(error) => {
                inner.record(error.clone());
                inner.phase = Phase::Enabled;
                inner.refresh();
                inner.runtime.error = Some(error.code);
            }
        }
        inner.runtime.clone()
    }

    pub fn set_lifetime(&self, lifetime: SshLifetime) -> SshRuntime {
        let mut inner = self.lock();
        if inner.runtime.read_only {
            inner.runtime.error = Some(ErrorCode::ReadOnly);
            return inner.runtime.clone();
        }
        if inner.settings.lifetime == lifetime {
            inner.refresh();
            return inner.runtime.clone();
        }
        inner.refresh();
        if inner.runtime.os_enabled && inner.runtime.owned {
            match inner.backend.set_lifetime(lifetime) {
                Ok(status) => {
                    inner.settings.lifetime = lifetime;
                    inner.apply_status(status);
                    match lifetime {
                        SshLifetime::App => {
                            let _ = inner.attach();
                        }
                        SshLifetime::Persistent => inner.detach(),
                    }
                }
                Err(error) => {
                    inner.record(error.clone());
                    inner.refresh();
                    inner.runtime.error = Some(error.code);
                }
            }
        } else {
            // 未开启时只持久化偏好。
            inner.settings.lifetime = lifetime;
        }
        inner.runtime.clone()
    }

    pub fn set_port(&self, port: u16) -> SshRuntime {
        let mut inner = self.lock();
        if inner.runtime.read_only {
            inner.runtime.error = Some(ErrorCode::ReadOnly);
            return inner.runtime.clone();
        }
        if port == 0 {
            inner.runtime.error = Some(ErrorCode::Internal);
            return inner.runtime.clone();
        }
        if inner.platform == Platform::MacOs && port != MACOS_PORT {
            inner.runtime.error = Some(ErrorCode::UnsupportedCustomPort);
            return inner.runtime.clone();
        }
        inner.refresh();
        if inner.runtime.os_enabled && inner.runtime.owned {
            match inner.backend.set_port(port) {
                Ok(status) => {
                    inner.settings.port = status.port;
                    inner.apply_status(status);
                }
                Err(error) => {
                    inner.record(error.clone());
                    inner.refresh();
                    inner.runtime.error = Some(error.code);
                }
            }
        } else {
            inner.settings.port = port;
            inner.runtime.port = port;
        }
        inner.runtime.clone()
    }

    pub fn install_helper(&self) -> SshRuntime {
        let mut inner = self.lock();
        if !inner.supported {
            inner.runtime.error = Some(ErrorCode::UnsupportedOs);
            return inner.runtime.clone();
        }
        if inner.runtime.read_only {
            inner.runtime.error = Some(ErrorCode::ReadOnly);
            return inner.runtime.clone();
        }
        match inner.backend.install_helper() {
            Ok(()) => inner.refresh(),
            Err(error) => {
                inner.record(error.clone());
                inner.refresh();
                inner.runtime.error = Some(error.code);
            }
        }
        inner.runtime.clone()
    }

    /// Windows FoD 失败时的兜底：安装随包固定版 OpenSSH（用户已在 UI 确认）。
    pub fn install_bundled(&self) -> SshRuntime {
        let mut inner = self.lock();
        if !inner.supported {
            inner.runtime.error = Some(ErrorCode::UnsupportedOs);
            return inner.runtime.clone();
        }
        if inner.runtime.read_only {
            inner.runtime.error = Some(ErrorCode::ReadOnly);
            return inner.runtime.clone();
        }
        let result = inner.backend.install_bundled();
        // 先刷新真实状态，再把本次动作的错误盖回去：refresh 会清空 error。
        inner.refresh();
        match result {
            Ok(status) => {
                inner.apply_status(status);
                inner.runtime.error = None;
            }
            Err(error) => {
                inner.record(error.clone());
                inner.runtime.error = Some(error.code);
            }
        }
        inner.runtime.clone()
    }

    pub fn uninstall_helper(&self) -> SshRuntime {
        let mut inner = self.lock();
        if inner.runtime.read_only {
            inner.runtime.error = Some(ErrorCode::ReadOnly);
            return inner.runtime.clone();
        }
        if inner.runtime.owned {
            if let Err(error) = inner.backend.disable() {
                inner.record(error);
            }
        }
        match inner.backend.uninstall_helper() {
            Ok(()) => {}
            Err(error) => {
                inner.record(error.clone());
                inner.runtime.error = Some(error.code);
            }
        }
        inner.settings.enabled = false;
        inner.detach();
        inner.refresh();
        inner.runtime.clone()
    }

    /// 窗口关闭 / 进程退出：只释放会话，是否关 sshd 由 helper 按自己的生命周期决定。
    pub fn shutdown(&self) {
        let mut inner = self.lock();
        while inner.clients > 0 {
            inner.detach();
        }
    }

    #[cfg(test)]
    fn phase(&self) -> Phase {
        self.lock().phase
    }

    #[cfg(test)]
    fn clients(&self) -> u32 {
        self.lock().clients
    }
}

fn username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "user".to_string())
}

/// `ssh_status` 的一次完整读取：真实现状 + 持久化的期望状态。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSnapshot {
    pub runtime: SshRuntime,
    pub ssh: SshSettings,
}

/// 命令结果：`error` 是本动作的错误码，`runtime` 是动作之后的真实现状。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshOutcome {
    pub runtime: SshRuntime,
    /// 动作之后持久化的期望状态，前端据此同步开关/生命周期/端口。
    pub ssh: SshSettings,
    pub error: Option<ErrorCode>,
}

fn outcome(runtime: SshRuntime, manager: &SshManager) -> SshOutcome {
    SshOutcome {
        error: runtime.error,
        runtime,
        ssh: manager.desired(),
    }
}

/// 成功时才写 settings.json：特权操作失败不能把 `enabled=true` 落盘。
fn finalize(
    app: &AppHandle,
    state: &SettingsState,
    manager: &SshManager,
    outcome: SshOutcome,
) -> SshOutcome {
    let mut outcome = outcome;
    if outcome.error.is_none() {
        if let Err(message) = settings::save_ssh(app, state, manager.desired()) {
            eprintln!("ssh: persist failed: {message}");
            outcome.error = Some(ErrorCode::Internal);
            outcome.runtime.error = Some(ErrorCode::Internal);
        }
    }
    outcome.ssh = manager.desired();
    let _ = app.emit("ssh-status", outcome.runtime.clone());
    outcome
}

async fn run_blocking(
    manager: &State<'_, SshManager>,
    label: &str,
    action: impl FnOnce(SshManager) -> SshRuntime + Send + 'static,
) -> Result<SshRuntime, String> {
    let handle: SshManager = (**manager).clone();
    tauri::async_runtime::spawn_blocking(move || action(handle))
        .await
        .map_err(|_| format!("{label}失败，请重试"))
}

/// 打开系统设置里的“共享”面板（只读路线的引导入口）。
#[tauri::command]
pub async fn ssh_open_sharing_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(macos_readonly::open_sharing_settings)
            .await
            .map_err(|_| "打开系统设置失败".to_string())?
            .map_err(|_| "打开系统设置失败，请手动前往 系统设置 → 通用 → 共享".to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("只有 macOS 需要手动开启".to_string())
    }
}

#[tauri::command]
pub async fn ssh_status(manager: State<'_, SshManager>) -> Result<SshSnapshot, String> {
    let runtime = run_blocking(&manager, "读取 SSH 状态", |handle| handle.refresh()).await?;
    Ok(SshSnapshot {
        runtime,
        ssh: manager.desired(),
    })
}

#[tauri::command]
pub async fn ssh_enable(
    app: AppHandle,
    state: State<'_, SettingsState>,
    manager: State<'_, SshManager>,
    lifetime: Option<SshLifetime>,
    port: Option<u16>,
) -> Result<SshOutcome, String> {
    let current = state.get().ssh;
    let lifetime = lifetime.unwrap_or(current.lifetime);
    let port = port.unwrap_or(current.port);
    if port == 0 {
        return Err("SSH 端口需要在 1 到 65535 之间".to_string());
    }
    let runtime = run_blocking(&manager, "开启 SSH", move |handle| {
        handle.enable(lifetime, port)
    })
    .await?;
    Ok(finalize(&app, &state, &manager, outcome(runtime, &manager)))
}

#[tauri::command]
pub async fn ssh_disable(
    app: AppHandle,
    state: State<'_, SettingsState>,
    manager: State<'_, SshManager>,
) -> Result<SshOutcome, String> {
    let runtime = run_blocking(&manager, "关闭 SSH", |handle| handle.disable()).await?;
    Ok(finalize(&app, &state, &manager, outcome(runtime, &manager)))
}

#[tauri::command]
pub async fn ssh_set_lifetime(
    app: AppHandle,
    state: State<'_, SettingsState>,
    manager: State<'_, SshManager>,
    lifetime: SshLifetime,
) -> Result<SshOutcome, String> {
    let runtime = run_blocking(&manager, "切换 SSH 生命周期", move |handle| {
        handle.set_lifetime(lifetime)
    })
    .await?;
    Ok(finalize(&app, &state, &manager, outcome(runtime, &manager)))
}

#[tauri::command]
pub async fn ssh_set_port(
    app: AppHandle,
    state: State<'_, SettingsState>,
    manager: State<'_, SshManager>,
    port: u16,
) -> Result<SshOutcome, String> {
    if port == 0 {
        return Err("SSH 端口需要在 1 到 65535 之间".to_string());
    }
    let runtime = run_blocking(&manager, "修改 SSH 端口", move |handle| {
        handle.set_port(port)
    })
    .await?;
    Ok(finalize(&app, &state, &manager, outcome(runtime, &manager)))
}

#[tauri::command]
pub async fn ssh_install_helper(
    app: AppHandle,
    state: State<'_, SettingsState>,
    manager: State<'_, SshManager>,
) -> Result<SshOutcome, String> {
    let runtime = run_blocking(&manager, "安装辅助服务", |handle| {
        handle.install_helper()
    })
    .await?;
    Ok(finalize(&app, &state, &manager, outcome(runtime, &manager)))
}

/// 官网下载地址固定在后台：前端不能传任意 URL。
pub const OPENSSH_DOWNLOAD_URL: &str = "https://github.com/PowerShell/Win32-OpenSSH/releases";

/// 打开 OpenSSH 官方发布页（FoD 失败时的手动兜底）。
#[tauri::command]
pub fn ssh_open_open_ssh_download() -> Result<(), String> {
    let program = if cfg!(target_os = "windows") {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(OPENSSH_DOWNLOAD_URL)
        .spawn()
        .map(|_| ())
        .map_err(|_| "无法打开下载页面".to_string())
}

/// Windows 缺少 sshd 时安装随包固定版 OpenSSH。
#[tauri::command]
pub async fn ssh_install_bundled_open_ssh(
    app: AppHandle,
    state: State<'_, SettingsState>,
    manager: State<'_, SshManager>,
) -> Result<SshOutcome, String> {
    let runtime = run_blocking(&manager, "安装内置 OpenSSH", |handle| {
        handle.install_bundled()
    })
    .await?;
    Ok(finalize(&app, &state, &manager, outcome(runtime, &manager)))
}

#[tauri::command]
pub async fn ssh_uninstall_helper(
    app: AppHandle,
    state: State<'_, SettingsState>,
    manager: State<'_, SshManager>,
) -> Result<SshOutcome, String> {
    let runtime = run_blocking(&manager, "卸载辅助服务", |handle| {
        handle.uninstall_helper()
    })
    .await?;
    Ok(finalize(&app, &state, &manager, outcome(runtime, &manager)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    struct FakeState {
        os_enabled: bool,
        owned: bool,
        listening: bool,
        port: u16,
        lifetime: SshLifetime,
        helper: HelperInfo,
        fail_next: Option<ErrorCode>,
        fail_attach: bool,
        calls: Vec<&'static str>,
        attach_calls: u32,
        detach_calls: u32,
    }

    impl Default for FakeState {
        fn default() -> Self {
            Self {
                os_enabled: false,
                owned: false,
                listening: false,
                port: DEFAULT_PORT,
                lifetime: SshLifetime::App,
                helper: HelperInfo {
                    available: true,
                    writable: true,
                    installed: true,
                    approved: true,
                    version: Some("1.0.0".to_string()),
                },
                fail_next: None,
                fail_attach: false,
                calls: Vec::new(),
                attach_calls: 0,
                detach_calls: 0,
            }
        }
    }

    struct FakeBackend {
        state: StdMutex<FakeState>,
    }

    impl FakeBackend {
        fn new() -> Arc<FakeBackend> {
            Arc::new(Self {
                state: StdMutex::new(FakeState::default()),
            })
        }

        fn lock(&self) -> std::sync::MutexGuard<'_, FakeState> {
            self.state.lock().unwrap()
        }

        fn pre_enabled(&self) {
            let mut state = self.lock();
            state.os_enabled = true;
            state.listening = true;
        }

        fn fail_next(&self, code: ErrorCode) {
            self.lock().fail_next = Some(code);
        }

        fn calls(&self) -> Vec<&'static str> {
            self.lock().calls.clone()
        }

        fn status_of(&self) -> HelperStatus {
            let state = self.lock();
            HelperStatus {
                enabled: state.os_enabled,
                os_enabled: state.os_enabled,
                os_state: Some(if state.os_enabled {
                    shrinkdrop_ssh_core::OsState::Enabled
                } else {
                    shrinkdrop_ssh_core::OsState::Disabled
                }),
                listening: state.listening,
                port: state.port,
                owned: state.owned,
                lifetime: state.lifetime,
                install_source: InstallSource::System,
                bundled_version: None,
                port_in_use: None,
                fingerprint: Some("SHA256:test".to_string()),
            }
        }
    }

    impl SshBackend for FakeBackend {
        fn helper_info(&self) -> HelperInfo {
            self.lock().helper.clone()
        }

        fn status(&self) -> Result<HelperStatus, SshError> {
            {
                let state = self.lock();
                if !state.helper.installed {
                    return Err(SshError::new(ErrorCode::HelperUnavailable));
                }
            }
            Ok(self.status_of())
        }

        fn enable(&self, lifetime: SshLifetime, port: u16) -> Result<HelperStatus, SshError> {
            {
                let mut state = self.lock();
                state.calls.push("enable");
                if !state.helper.installed {
                    return Err(SshError::new(ErrorCode::HelperUnavailable));
                }
                if let Some(code) = state.fail_next.take() {
                    return Err(SshError::new(code));
                }
                state.os_enabled = true;
                state.owned = true;
                state.listening = true;
                state.port = port;
                state.lifetime = lifetime;
            }
            Ok(self.status_of())
        }

        fn disable(&self) -> Result<HelperStatus, SshError> {
            {
                let mut state = self.lock();
                state.calls.push("disable");
                if let Some(code) = state.fail_next.take() {
                    return Err(SshError::new(code));
                }
                state.os_enabled = false;
                state.owned = false;
                state.listening = false;
            }
            Ok(self.status_of())
        }

        fn set_lifetime(&self, lifetime: SshLifetime) -> Result<HelperStatus, SshError> {
            {
                let mut state = self.lock();
                state.calls.push("set_lifetime");
                if let Some(code) = state.fail_next.take() {
                    return Err(SshError::new(code));
                }
                state.lifetime = lifetime;
            }
            Ok(self.status_of())
        }

        fn set_port(&self, port: u16) -> Result<HelperStatus, SshError> {
            {
                let mut state = self.lock();
                state.calls.push("set_port");
                if let Some(code) = state.fail_next.take() {
                    return Err(SshError::new(code));
                }
                state.port = port;
            }
            Ok(self.status_of())
        }

        fn attach(&self) -> Result<(), SshError> {
            let mut state = self.lock();
            state.attach_calls += 1;
            if state.fail_attach {
                return Err(SshError::new(ErrorCode::HelperUnavailable));
            }
            Ok(())
        }

        fn detach(&self) -> Result<(), SshError> {
            self.lock().detach_calls += 1;
            Ok(())
        }

        fn install_helper(&self) -> Result<(), SshError> {
            let mut state = self.lock();
            state.calls.push("install_helper");
            state.helper.installed = true;
            state.helper.approved = true;
            Ok(())
        }

        fn uninstall_helper(&self) -> Result<(), SshError> {
            let mut state = self.lock();
            state.calls.push("uninstall_helper");
            state.helper.installed = false;
            state.helper.approved = false;
            Ok(())
        }

        fn install_bundled(&self) -> Result<HelperStatus, SshError> {
            {
                let mut state = self.lock();
                state.calls.push("install_bundled");
                if let Some(code) = state.fail_next.take() {
                    return Err(SshError::new(code));
                }
            }
            Ok(self.status_of())
        }
    }

    fn fixture(platform: Platform) -> (Arc<FakeBackend>, SshManager) {
        fixture_with(platform, true)
    }

    fn fixture_with(platform: Platform, supported: bool) -> (Arc<FakeBackend>, SshManager) {
        let backend = FakeBackend::new();
        let manager =
            SshManager::with_capabilities(backend.clone(), platform, supported, SshSettings::default());
        (backend, manager)
    }

    #[test]
    fn settings_without_ssh_block_fall_back_to_defaults() {
        let settings: crate::settings::Settings = serde_json::from_str("{}").unwrap();
        assert!(!settings.ssh.enabled);
        assert_eq!(settings.ssh.lifetime, SshLifetime::App);
        assert_eq!(settings.ssh.port, DEFAULT_PORT);
    }

    #[test]
    fn ssh_settings_roundtrip_through_the_settings_file() {
        let settings = crate::settings::Settings {
            ssh: SshSettings {
                enabled: true,
                lifetime: SshLifetime::Persistent,
                port: 2222,
            },
            ..crate::settings::Settings::default()
        };
        let encoded = serde_json::to_string(&settings).unwrap();
        let decoded: crate::settings::Settings = serde_json::from_str(&encoded).unwrap();
        assert!(decoded.ssh.enabled);
        assert_eq!(decoded.ssh.lifetime, SshLifetime::Persistent);
        assert_eq!(decoded.ssh.port, 2222);
    }

    #[test]
    fn unknown_lifetime_is_rejected() {
        let parsed: Result<SshSettings, _> =
            serde_json::from_str(r#"{"enabled":true,"lifetime":"forever","port":22}"#);
        assert!(parsed.is_err());
    }

    #[test]
    fn port_zero_is_invalid() {
        let settings = SshSettings {
            port: 0,
            ..SshSettings::default()
        };
        assert!(settings.validate().is_err());
    }

    #[test]
    fn macos_effective_port_ignores_a_stale_custom_port() {
        let settings = SshSettings {
            port: 2222,
            ..SshSettings::default()
        };
        assert_eq!(settings.effective_port(Platform::MacOs), MACOS_PORT);
        assert_eq!(settings.effective_port(Platform::Windows), 2222);
    }

    #[test]
    fn defaults_are_off_and_port_22() {
        let settings = SshSettings::default();
        assert_eq!(settings.port, DEFAULT_PORT);
        assert_eq!(settings.lifetime, SshLifetime::App);
        assert!(!settings.enabled);
        assert!(settings.validate().is_ok());

        let (_, manager) = fixture(Platform::MacOs);
        let runtime = manager.refresh();
        assert!(!runtime.os_enabled);
        assert!(!runtime.owned);
        assert_eq!(runtime.port, 22);
        assert_eq!(manager.desired().enabled, false);
    }

    #[test]
    fn enable_takes_ownership_and_reports_open_port() {
        let (backend, manager) = fixture(Platform::MacOs);
        let runtime = manager.enable(SshLifetime::App, 22);
        assert_eq!(runtime.error, None);
        assert!(runtime.os_enabled);
        assert!(runtime.owned);
        assert!(runtime.listening);
        assert_eq!(runtime.port, 22);
        assert_eq!(manager.desired().enabled, true);
        assert_eq!(backend.calls(), vec!["enable"]);
        assert_eq!(backend.lock().attach_calls, 1);
        assert_eq!(manager.phase(), Phase::Enabled);
    }

    #[test]
    fn enable_when_os_already_on_does_not_take_ownership() {
        let (backend, manager) = fixture(Platform::MacOs);
        backend.pre_enabled();
        let runtime = manager.enable(SshLifetime::Persistent, 22);
        assert_eq!(runtime.error, None);
        assert!(runtime.os_enabled);
        assert!(!runtime.owned, "系统里已有的实例不属于应用");
        assert!(backend.calls().is_empty(), "不应重复启动");
        assert_eq!(manager.desired().lifetime, SshLifetime::Persistent);
    }

    #[test]
    fn disable_only_stops_the_instance_we_own() {
        let (backend, manager) = fixture(Platform::MacOs);
        backend.pre_enabled();
        let runtime = manager.disable();
        assert_eq!(runtime.error, None);
        assert!(runtime.os_enabled, "用户手动开启的 SSH 不能被误关");
        assert_eq!(manager.desired().enabled, false);
        assert!(backend.calls().is_empty());
    }

    #[test]
    fn disable_stops_owned_instance_and_clears_desired() {
        let (backend, manager) = fixture(Platform::MacOs);
        assert!(manager.enable(SshLifetime::App, 22).owned);
        let runtime = manager.disable();
        assert_eq!(runtime.error, None);
        assert!(!runtime.os_enabled);
        assert_eq!(manager.desired().enabled, false);
        assert_eq!(backend.calls(), vec!["enable", "disable"]);
        assert_eq!(backend.lock().detach_calls, 1);
    }

    #[test]
    fn failed_enable_keeps_desired_state_disabled() {
        let (backend, manager) = fixture(Platform::MacOs);
        backend.fail_next(ErrorCode::ServiceStartFailed);
        let runtime = manager.enable(SshLifetime::App, 22);
        assert_eq!(runtime.error, Some(ErrorCode::ServiceStartFailed));
        assert!(!runtime.os_enabled);
        assert_eq!(manager.desired().enabled, false);
        assert_eq!(manager.phase(), Phase::Disabled);
    }

    #[test]
    fn attach_failure_rolls_back_instead_of_leaving_an_open_door() {
        let (backend, manager) = fixture(Platform::MacOs);
        backend.lock().fail_attach = true;
        let runtime = manager.enable(SshLifetime::App, 22);
        assert_eq!(runtime.error, Some(ErrorCode::HelperUnavailable));
        assert!(!runtime.os_enabled, "回滚后 sshd 不应继续开着");
        assert_eq!(manager.desired().enabled, false);
        assert_eq!(manager.phase(), Phase::Disabled);
        assert!(backend.calls().contains(&"disable"));
    }

    #[test]
    fn helper_missing_surfaces_helper_unavailable() {
        let backend = FakeBackend::new();
        backend.lock().helper = HelperInfo::default();
        let manager = SshManager::new(backend.clone(), Platform::MacOs, SshSettings::default());
        let runtime = manager.refresh();
        assert_eq!(runtime.error, Some(ErrorCode::HelperUnavailable));
        assert!(!runtime.helper_installed);
        assert!(!runtime.backend_available, "此构建没有可用的控制面后端");

        let runtime = manager.enable(SshLifetime::App, 22);
        assert_eq!(runtime.error, Some(ErrorCode::HelperUnavailable));
        assert_eq!(manager.desired().enabled, false);

        let runtime = manager.install_helper();
        assert!(runtime.helper_installed);
        assert_eq!(runtime.error, None);
    }

    #[test]
    fn macos_rejects_custom_port_without_touching_the_system() {
        let (backend, manager) = fixture(Platform::MacOs);
        let runtime = manager.enable(SshLifetime::Persistent, 2222);
        assert_eq!(runtime.error, Some(ErrorCode::UnsupportedCustomPort));
        assert!(backend.calls().is_empty());
        assert_eq!(manager.desired().port, 22);

        let runtime = manager.set_port(2222);
        assert_eq!(runtime.error, Some(ErrorCode::UnsupportedCustomPort));
        assert_eq!(manager.desired().port, 22);
    }

    #[test]
    fn unsupported_platform_never_calls_the_backend() {
        let (backend, manager) = fixture_with(Platform::Other, false);
        let runtime = manager.refresh();
        assert!(!runtime.supported);
        let runtime = manager.enable(SshLifetime::App, 22);
        assert_eq!(runtime.error, Some(ErrorCode::UnsupportedOs));
        assert!(backend.calls().is_empty());
    }

    #[test]
    fn lifetime_switch_drives_attach_and_detach() {
        let (backend, manager) = fixture(Platform::Windows);
        assert!(manager.refresh().supported);
        manager.enable(SshLifetime::Persistent, 22);
        assert_eq!(backend.lock().attach_calls, 0, "常驻模式不需要会话");

        let runtime = manager.set_lifetime(SshLifetime::App);
        assert_eq!(runtime.error, None);
        assert_eq!(backend.lock().attach_calls, 1);
        assert_eq!(manager.desired().lifetime, SshLifetime::App);

        let runtime = manager.set_lifetime(SshLifetime::Persistent);
        assert_eq!(runtime.error, None);
        assert_eq!(backend.lock().detach_calls, 1);
        assert_eq!(manager.desired().lifetime, SshLifetime::Persistent);
        assert!(backend.calls().contains(&"set_lifetime"));
    }

    #[test]
    fn port_change_only_hits_the_backend_when_enabled() {
        let (backend, manager) = fixture(Platform::Windows);
        manager.set_port(2222);
        assert_eq!(manager.desired().port, 2222);
        assert!(backend.calls().is_empty(), "未开启时只持久化偏好");

        manager.enable(SshLifetime::Persistent, 2222);
        manager.set_port(2200);
        assert_eq!(manager.desired().port, 2200);
        assert_eq!(backend.calls(), vec!["enable", "set_port"]);
    }

    #[test]
    fn install_bundled_goes_through_the_backend_only_on_supported_platforms() {
        let (backend, manager) = fixture(Platform::Windows);
        let runtime = manager.install_bundled();
        assert_eq!(runtime.error, None);
        assert_eq!(backend.calls(), vec!["install_bundled"]);

        let (backend, manager) = fixture_with(Platform::Other, false);
        let runtime = manager.install_bundled();
        assert_eq!(runtime.error, Some(ErrorCode::UnsupportedOs));
        assert!(backend.calls().is_empty());
    }

    #[test]
    fn install_bundled_failure_is_reported_and_not_persisted() {
        let (backend, manager) = fixture(Platform::Windows);
        backend.fail_next(ErrorCode::FeatureMissing);
        let runtime = manager.install_bundled();
        assert_eq!(runtime.error, Some(ErrorCode::FeatureMissing));
        assert!(!manager.desired().enabled, "安装失败不能把 enabled 落盘");
    }

    #[test]
    fn attach_refcount_detaches_only_with_the_last_client() {
        let (backend, manager) = fixture(Platform::MacOs);
        manager.enable(SshLifetime::App, 22);
        assert_eq!(manager.clients(), 1);

        // 启动对齐再次 attach：只是加引用计数，不重复开会话。
        manager.reconcile(SshSettings {
            enabled: true,
            lifetime: SshLifetime::App,
            port: 22,
        });
        assert_eq!(manager.clients(), 2);
        assert_eq!(backend.lock().attach_calls, 1);

        manager.shutdown();
        assert_eq!(manager.clients(), 0);
        assert_eq!(backend.lock().detach_calls, 1);
    }

    #[test]
    fn uninstall_stops_owned_ssh_and_clears_desired() {
        let (backend, manager) = fixture(Platform::MacOs);
        manager.enable(SshLifetime::Persistent, 22);
        let runtime = manager.uninstall_helper();
        assert!(!runtime.helper_installed);
        assert!(!runtime.os_enabled);
        assert_eq!(manager.desired().enabled, false);
        assert!(backend.calls().contains(&"disable"));
        assert!(backend.calls().contains(&"uninstall_helper"));
    }

    struct ReadOnlyFake;

    impl SshBackend for ReadOnlyFake {
        fn helper_info(&self) -> HelperInfo {
            HelperInfo {
                available: true,
                writable: false,
                installed: false,
                approved: false,
                version: None,
            }
        }

        fn status(&self) -> Result<HelperStatus, SshError> {
            Ok(HelperStatus {
                enabled: false,
                os_enabled: false,
                os_state: Some(shrinkdrop_ssh_core::OsState::Unknown),
                listening: true,
                port: 22,
                owned: false,
                lifetime: SshLifetime::Persistent,
                install_source: InstallSource::System,
                bundled_version: None,
                port_in_use: Some(PortOwner {
                    port: 22,
                    pid: 0,
                    process: "unknown".to_string(),
                }),
                fingerprint: None,
            })
        }

        fn enable(&self, _l: SshLifetime, _p: u16) -> Result<HelperStatus, SshError> {
            Err(SshError::new(ErrorCode::ReadOnly))
        }

        fn disable(&self) -> Result<HelperStatus, SshError> {
            Err(SshError::new(ErrorCode::ReadOnly))
        }

        fn set_lifetime(&self, _l: SshLifetime) -> Result<HelperStatus, SshError> {
            Err(SshError::new(ErrorCode::ReadOnly))
        }

        fn set_port(&self, _p: u16) -> Result<HelperStatus, SshError> {
            Err(SshError::new(ErrorCode::ReadOnly))
        }

        fn attach(&self) -> Result<(), SshError> {
            Err(SshError::new(ErrorCode::ReadOnly))
        }

        fn detach(&self) -> Result<(), SshError> {
            Ok(())
        }

        fn install_helper(&self) -> Result<(), SshError> {
            Err(SshError::new(ErrorCode::ReadOnly))
        }

        fn uninstall_helper(&self) -> Result<(), SshError> {
            Ok(())
        }
    }

    #[test]
    fn read_only_runtime_exposes_unknown_state_without_claiming_enabled() {
        let manager = SshManager::new(Arc::new(ReadOnlyFake), Platform::MacOs, SshSettings::default());
        let runtime = manager.refresh();
        assert!(runtime.read_only);
        assert!(runtime.backend_available);
        assert_eq!(runtime.os_state, "unknown");
        assert!(!runtime.os_enabled, "unknown 不能当作已开启");
        assert_eq!(runtime.port_in_use.map(|owner| owner.port), Some(22));
        assert_eq!(runtime.error, None);
    }

    #[test]
    fn read_only_rejects_every_write_and_keeps_desired_state() {
        let manager = SshManager::new(Arc::new(ReadOnlyFake), Platform::MacOs, SshSettings::default());
        manager.refresh();

        for runtime in [
            manager.enable(SshLifetime::App, 22),
            manager.disable(),
            manager.set_lifetime(SshLifetime::Persistent),
            manager.set_port(2222),
            manager.install_helper(),
            manager.uninstall_helper(),
        ] {
            assert_eq!(runtime.error, Some(ErrorCode::ReadOnly));
        }
        let desired = manager.desired();
        assert!(!desired.enabled, "只读模式不得把 enabled 落盘");
        assert_eq!(desired.lifetime, SshLifetime::App);
        assert_eq!(desired.port, 22);
    }

    #[test]
    fn macos_port_is_normalized_to_22() {
        let backend = FakeBackend::new();
        let manager = SshManager::with_capabilities(
            backend,
            Platform::MacOs,
            true,
            SshSettings {
                port: 2222,
                ..SshSettings::default()
            },
        );
        assert_eq!(manager.desired().port, 22);
        assert_eq!(manager.refresh().port, 22);
    }

    #[test]
    fn busy_phase_rejects_concurrent_actions() {
        let (backend, manager) = fixture(Platform::MacOs);
        manager.lock().phase = Phase::Enabling;
        assert_eq!(
            manager.enable(SshLifetime::App, 22).error,
            Some(ErrorCode::Busy)
        );
        assert_eq!(manager.disable().error, Some(ErrorCode::Busy));
        assert!(backend.calls().is_empty());
    }

    #[test]
    fn disable_failure_keeps_the_instance_and_desired_state() {
        let (backend, manager) = fixture(Platform::MacOs);
        manager.enable(SshLifetime::Persistent, 22);
        backend.fail_next(ErrorCode::ServiceStopFailed);
        let runtime = manager.disable();
        assert_eq!(runtime.error, Some(ErrorCode::ServiceStopFailed));
        assert!(runtime.os_enabled, "停止失败后系统状态未变");
        assert_eq!(manager.desired().enabled, true);
    }

    #[test]
    fn lifetime_switch_failure_keeps_the_previous_preference() {
        let (backend, manager) = fixture(Platform::MacOs);
        manager.enable(SshLifetime::Persistent, 22);
        backend.fail_next(ErrorCode::Internal);
        let runtime = manager.set_lifetime(SshLifetime::App);
        assert_eq!(runtime.error, Some(ErrorCode::Internal));
        assert_eq!(manager.desired().lifetime, SshLifetime::Persistent);
        assert_eq!(backend.lock().attach_calls, 0);
    }

    #[test]
    fn port_change_failure_keeps_the_previous_port() {
        let (backend, manager) = fixture(Platform::Windows);
        manager.enable(SshLifetime::Persistent, 2222);
        backend.fail_next(ErrorCode::PortInUse);
        let runtime = manager.set_port(2200);
        assert_eq!(runtime.error, Some(ErrorCode::PortInUse));
        assert_eq!(manager.desired().port, 2222);
        assert_eq!(runtime.port, 2222);
    }

    #[test]
    fn reconcile_waits_for_helper_approval_before_attaching() {
        let (backend, manager) = fixture(Platform::MacOs);
        backend.lock().helper.approved = false;
        manager.reconcile(SshSettings {
            enabled: true,
            lifetime: SshLifetime::App,
            port: 22,
        });
        assert_eq!(backend.lock().attach_calls, 0);
        assert!(!manager.runtime().helper_approved);

        backend.lock().helper.approved = true;
        manager.reconcile(SshSettings {
            enabled: true,
            lifetime: SshLifetime::App,
            port: 22,
        });
        assert_eq!(backend.lock().attach_calls, 1);
    }
}
