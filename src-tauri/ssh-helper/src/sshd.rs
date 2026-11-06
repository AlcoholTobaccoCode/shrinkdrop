//! Windows sshd 控制：服务状态、启动/停止、启动类型、可选功能安装、端口、防火墙。
//!
//! 全部是固定 argv 的 `sc.exe` / `dism.exe` / `netsh.exe` / `msiexec.exe` 调用，
//! 没有任何 shell 拼接，也不接受调用方传入的程序路径。

use std::sync::Arc;

use shrinkdrop_ssh_core::{ErrorCode, InstallSource, PortOwner};

use crate::runner::{Output, Runner};

pub const SERVICE: &str = "sshd";
pub const FOD_NAME: &str = "OpenSSH.Server~~~~0.0.1.0";
pub const CONFIG_PATH: &str = r"C:\ProgramData\ssh\sshd_config";
pub const HOST_KEY: &str = r"C:\ProgramData\ssh\ssh_host_ed25519_key.pub";
/// host key 回退顺序：ed25519 → ecdsa → rsa（新装机可能只生成了其中一种）。
pub const HOST_KEYS: [&str; 3] = [
    HOST_KEY,
    r"C:\ProgramData\ssh\ssh_host_ecdsa_key.pub",
    r"C:\ProgramData\ssh\ssh_host_rsa_key.pub",
];
pub const SSH_EXE: &str = r"C:\Windows\System32\OpenSSH\sshd.exe";
pub const BUNDLED_SSH_EXE: &str = r"C:\Program Files\OpenSSH-Win64\sshd.exe";
pub const FIREWALL_RULE: &str = "OpenSSH-Server-In-TCP";

/// 启动类型（只允许这三档；其它值一律视为未知）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartType {
    Auto,
    Demand,
    Disabled,
    Unknown,
}

impl StartType {
    pub fn as_sc_value(self) -> &'static str {
        match self {
            StartType::Auto => "auto",
            StartType::Demand => "demand",
            StartType::Disabled => "disabled",
            StartType::Unknown => "demand",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto" | "automatic" | "auto_start" => StartType::Auto,
            "demand" | "manual" | "demand_start" => StartType::Demand,
            "disabled" | "disable" => StartType::Disabled,
            _ => StartType::Unknown,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceState {
    Running,
    Stopped,
    NotFound,
    Unknown,
}

/// `sc.exe query sshd` 的解析结果。
pub fn parse_service_state(output: &Output) -> ServiceState {
    let text = format!("{}\n{}", output.stdout, output.stderr).to_ascii_lowercase();
    if text.contains("1060") || text.contains("does not exist") || text.contains("指定的服务") {
        return ServiceState::NotFound;
    }
    if text.contains("running") {
        return ServiceState::Running;
    }
    if text.contains("stopped") {
        return ServiceState::Stopped;
    }
    ServiceState::Unknown
}

/// `sc.exe qc sshd` 里 `START_TYPE` 的解析。
pub fn parse_start_type(output: &Output) -> StartType {
    for line in output.stdout.lines().chain(output.stderr.lines()) {
        let lower = line.to_ascii_lowercase();
        if let Some(index) = lower.find("start_type") {
            let rest = &line[index + "start_type".len()..];
            let value = rest.trim_start_matches(|c: char| c == ':' || c.is_whitespace());
            // `sc qc` 输出是 `2   AUTO_START`：数字只是枚举值，语义在后面的符号名。
            if let Some(kind) = value
                .split_whitespace()
                .map(StartType::parse)
                .find(|kind| *kind != StartType::Unknown)
            {
                return kind;
            }
        }
    }
    StartType::Unknown
}

/// `netstat -ano` 中监听指定端口的 PID。
pub fn parse_listener_pid(netstat: &str, port: u16) -> Option<u32> {
    let needle = format!(":{port}");
    netstat.lines().find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 5 || !fields[3].eq_ignore_ascii_case("LISTENING") {
            return None;
        }
        let local = fields[1];
        if !local.ends_with(&needle) {
            return None;
        }
        // 形如 0.0.0.0:2222 或 [::]:2222，后缀必须就是目标端口。
        let after = local.rsplit_once(':').map(|(_, tail)| tail)?;
        if after != port.to_string() {
            return None;
        }
        fields[4].parse::<u32>().ok()
    })
}

/// `tasklist /fi "PID eq N" /fo csv /nh` → 进程名。
pub fn parse_tasklist_name(csv: &str) -> Option<String> {
    let line = csv.lines().find(|line| !line.trim().is_empty())?;
    let name = line.split(',').next()?.trim().trim_matches('"');
    if name.is_empty() || name.contains(' ') && !name.contains(".exe") {
        return None;
    }
    Some(name.to_string())
}

/// `dism /online /get-featureinfo` 的 State 行。
pub fn parse_feature_state(output: &Output) -> Option<String> {
    output
        .stdout
        .lines()
        .find(|line| line.to_ascii_lowercase().contains("state"))
        .and_then(|line| line.split_once(':').map(|(_, value)| value.trim().to_string()))
}

/// `msiexec` 返回码到错误码。
pub fn map_msiexec_code(code: i32) -> Option<ErrorCode> {
    match code {
        0 => None,
        // 3010：成功但需要重启。
        3010 => None,
        1603 => Some(ErrorCode::ServiceStartFailed),
        1618 => Some(ErrorCode::Busy),
        _ => Some(ErrorCode::Internal),
    }
}

pub struct SshdControl {
    runner: Arc<dyn Runner>,
}

impl SshdControl {
    pub fn new(runner: Arc<dyn Runner>) -> Self {
        Self { runner }
    }

    fn sc(&self, args: &[&str]) -> std::io::Result<Output> {
        self.runner.run("sc.exe", args)
    }

    pub fn service_state(&self) -> ServiceState {
        match self.sc(&["query", SERVICE]) {
            Ok(output) => parse_service_state(&output),
            Err(_) => ServiceState::Unknown,
        }
    }

    pub fn start_type(&self) -> StartType {
        match self.sc(&["qc", SERVICE]) {
            Ok(output) => parse_start_type(&output),
            Err(_) => StartType::Unknown,
        }
    }

    pub fn set_start_type(&self, kind: StartType) -> Result<(), ErrorCode> {
        let value = kind.as_sc_value();
        let output = self
            .sc(&["config", SERVICE, "start=", value])
            .map_err(|_| ErrorCode::Internal)?;
        if output.success() {
            Ok(())
        } else {
            Err(ErrorCode::ServiceStartFailed)
        }
    }

    pub fn start(&self) -> Result<(), ErrorCode> {
        let output = self.sc(&["start", SERVICE]).map_err(|_| ErrorCode::Internal)?;
        // 1056 = 已在运行，按幂等处理。
        if output.success() || output.code == 1056 {
            Ok(())
        } else {
            Err(ErrorCode::ServiceStartFailed)
        }
    }

    pub fn stop(&self) -> Result<(), ErrorCode> {
        let output = self.sc(&["stop", SERVICE]).map_err(|_| ErrorCode::Internal)?;
        // 1062 = 未启动，按幂等处理。
        if output.success() || output.code == 1062 {
            Ok(())
        } else {
            Err(ErrorCode::ServiceStopFailed)
        }
    }

    pub fn feature_installed(&self) -> bool {
        self.runner
            .run("dism.exe", &["/online", &format!("/get-featureinfo /featurename:{FOD_NAME}")])
            .ok()
            .and_then(|output| parse_feature_state(&output))
            .is_some_and(|state| !state.eq_ignore_ascii_case("notpresent"))
    }

    pub fn sshd_present(&self) -> bool {
        self.runner
            .run("cmd.exe", &["/C", &format!("if exist \"{SSH_EXE}\" (exit 0) else (exit 1)")])
            .map(|output| output.success())
            .unwrap_or(false)
    }

    /// FoD 装不上时的兜底：安装随包固定版 MSI（调用方已在 UI 里确认）。
    pub fn install_bundled(&self, msi: &std::path::Path) -> Result<(), ErrorCode> {
        // 已有 sshd 服务时禁止再装一套，避免两套 OpenSSH 抢服务名。
        if self.service_state() != ServiceState::NotFound {
            return Err(ErrorCode::ServiceMissing);
        }
        crate::bundled::install(self.runner.as_ref(), msi)
    }

    pub fn install_feature(&self) -> Result<(), ErrorCode> {
        let output = self
            .runner
            .run(
                "dism.exe",
                &["/online", "/add-capability", &format!("/name:{FOD_NAME}"), "/quiet", "/norestart"],
            )
            .map_err(|_| ErrorCode::Internal)?;
        match output.code {
            0 | 3010 => Ok(()),
            // 离线 / WSUS / 策略拦截：都归到 feature_missing，UI 给两手准备。
            _ => Err(ErrorCode::FeatureMissing),
        }
    }

    /// 端口占用：返回端口、PID、进程名。
    pub fn port_owner(&self, port: u16) -> Option<PortOwner> {
        let netstat = self.runner.run("netstat.exe", &["-ano"]).ok()?;
        let pid = parse_listener_pid(&netstat.stdout, port)?;
        let tasklist = self
            .runner
            .run("tasklist.exe", &["/fi", &format!("PID eq {pid}"), "/fo", "csv", "/nh"])
            .ok()?;
        let process = parse_tasklist_name(&tasklist.stdout).unwrap_or_else(|| "unknown".to_string());
        Some(PortOwner {
            port,
            pid,
            process,
        })
    }

    /// 换端口后确认旧端口已释放（否则 22 还开着，等于没有换）。
    pub fn port_released(&self, port: u16) -> bool {
        self.port_owner(port).is_none()
    }

    /// 端口是否已被**本机 sshd** 占用（幂等判断）。
    pub fn owned_by_sshd(&self, port: u16) -> bool {
        self.port_owner(port)
            .map(|owner| owner.process.eq_ignore_ascii_case("sshd.exe"))
            .unwrap_or(false)
    }

    /// 规则是否存在：只看 `netsh show rule` 的退出码，避免解析本地化文案。
    pub fn rule_exists(&self, rule_name: &str) -> bool {
        self.runner
            .run(
                "netsh.exe",
                &["advfirewall", "firewall", "show", "rule", &format!("name={rule_name}")],
            )
            .map(|output| output.success())
            .unwrap_or(false)
    }

    /// 建自己的规则（按名字幂等），不看系统那条 stock 规则：
    /// `netsh` 的输出是本地化的（中文 Windows 写“已启用”），按英文关键字判断会误判。
    pub fn ensure_firewall_rule(&self, port: u16, rule_name: &str) -> Result<(), ErrorCode> {
        let port_text = port.to_string();
        // 已有规则也要把 profile 改成 any：0.1.6 建的规则只有 private，
        // 网络被识别为「公用」时入站直接被拦，表现就是 ssh 一直超时。
        let verb = if self.rule_exists(rule_name) { "set" } else { "add" };
        let name = format!("name={rule_name}");
        let port_arg = format!("localport={port_text}");
        let mut args: Vec<&str> = vec![
            "advfirewall",
            "firewall",
            verb,
            "rule",
            &name,
            "dir=in",
            "action=allow",
            "protocol=TCP",
            &port_arg,
            "profile=any",
        ];
        if verb == "set" {
            // `netsh ... set rule` 需要 `new` 关键字分隔要改的字段。
            args.insert(5, "new");
        }
        let output = self.runner.run("netsh.exe", &args).map_err(|_| ErrorCode::Internal)?;
        if output.success() {
            Ok(())
        } else {
            Err(ErrorCode::FirewallBlocked)
        }
    }

    pub fn remove_firewall_rule(&self, rule_name: &str) {
        let _ = self.runner.run(
            "netsh.exe",
            &["advfirewall", "firewall", "delete", "rule", &format!("name={rule_name}")],
        );
    }

    /// `sshd -t` 配置语法校验。
    pub fn validate_config(&self) -> Result<(), ErrorCode> {
        let exe = if self.sshd_present() { SSH_EXE } else { BUNDLED_SSH_EXE };
        let output = self
            .runner
            .run(exe, &["-t"])
            .map_err(|_| ErrorCode::Internal)?;
        if output.success() {
            Ok(())
        } else {
            Err(ErrorCode::ServiceStartFailed)
        }
    }

    pub fn install_source(&self) -> InstallSource {
        if self.feature_installed() {
            InstallSource::Fod
        } else {
            InstallSource::System
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_state_is_parsed_from_sc_output() {
        let running = Output {
            code: 0,
            stdout: "SERVICE_NAME: sshd\n        TYPE               : 10  WIN32_OWN_PROCESS\n        STATE              : 4  RUNNING\n".to_string(),
            stderr: String::new(),
        };
        assert_eq!(parse_service_state(&running), ServiceState::Running);

        let stopped = Output {
            code: 0,
            stdout: "        STATE              : 1  STOPPED".to_string(),
            stderr: String::new(),
        };
        assert_eq!(parse_service_state(&stopped), ServiceState::Stopped);

        let missing = Output {
            code: 1060,
            stdout: String::new(),
            stderr: "[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\n指定的服务未安装。".to_string(),
        };
        assert_eq!(parse_service_state(&missing), ServiceState::NotFound);
    }

    #[test]
    fn start_type_is_parsed() {
        let output = Output {
            code: 0,
            stdout: "        START_TYPE         : 2   AUTO_START\n".to_string(),
            stderr: String::new(),
        };
        assert_eq!(parse_start_type(&output), StartType::Auto);

        let demand = Output {
            code: 0,
            stdout: "START_TYPE : 3   DEMAND_START".to_string(),
            stderr: String::new(),
        };
        assert_eq!(parse_start_type(&demand), StartType::Demand);
        assert_eq!(StartType::Unknown.as_sc_value(), "demand");
    }

    #[test]
    fn listener_pid_matches_exact_port_only() {
        let netstat = "\
  TCP    0.0.0.0:22             0.0.0.0:0              LISTENING       1234
  TCP    0.0.0.0:2222           0.0.0.0:0              LISTENING       5678
  TCP    [::]:2222              [::]:0                 LISTENING       5678
  TCP    127.0.0.1:1222         0.0.0.0:0              LISTENING       9999
";
        assert_eq!(parse_listener_pid(netstat, 22), Some(1234));
        assert_eq!(parse_listener_pid(netstat, 2222), Some(5678));
        assert_eq!(parse_listener_pid(netstat, 222), None);
        assert_eq!(parse_listener_pid(netstat, 2223), None);
    }

    #[test]
    fn tasklist_csv_name_is_parsed() {
        assert_eq!(
            parse_tasklist_name("\"python.exe\",\"4242\",\"Console\",\"1\",\"12,345 K\"\r\n"),
            Some("python.exe".to_string())
        );
        assert_eq!(parse_tasklist_name("\"sshd.exe\",\"9\",\"Services\",\"0\",\"1,024 K\""), Some("sshd.exe".to_string()));
        assert_eq!(parse_tasklist_name("INFO: No tasks are running"), None);
    }

    #[test]
    fn feature_state_is_parsed() {
        let output = Output {
            code: 0,
            stdout: "Feature Name : OpenSSH.Server~~~~0.0.1.0\r\nState : Installed\r\n".to_string(),
            stderr: String::new(),
        };
        assert_eq!(parse_feature_state(&output), Some("Installed".to_string()));
    }

    #[test]
    fn msiexec_codes_map_to_error_codes() {
        assert_eq!(map_msiexec_code(0), None);
        assert_eq!(map_msiexec_code(3010), None);
        assert_eq!(map_msiexec_code(1603), Some(ErrorCode::ServiceStartFailed));
        assert_eq!(map_msiexec_code(1618), Some(ErrorCode::Busy));
        assert_eq!(map_msiexec_code(1638), Some(ErrorCode::Internal));
    }
}
