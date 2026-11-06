//! 假实现：在任意平台上模拟 Windows 系统状态，用来验证 helper 的状态机。
//!
//! 只模拟 helper 真正依赖的那部分 SCM/DISM/防火墙行为，不做完整仿真。
//! 由 `feature = "testing"` 开放给 app 侧的端到端协议测试复用。

use std::collections::HashMap;
use std::sync::Mutex;

use crate::config::ConfigIo;
use crate::runner::{Output, Runner};
use crate::state::StateIo;

#[derive(Clone, Debug, PartialEq)]
pub enum Svc {
    Stopped { start: String },
    Running { start: String },
}

#[derive(Default)]
pub struct FakeSystem {
    pub svc: Option<Svc>,
    pub start: String,
    pub listeners: HashMap<u16, (u32, String)>,
    pub rules: Vec<String>,
    pub feature: bool,
    pub config_valid: bool,
    pub config: String,
    pub files: HashMap<String, String>,
    pub fail_start: bool,
    pub fail_stop: bool,
}

pub struct Fake {
    inner: Mutex<FakeSystem>,
}

impl Fake {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(FakeSystem {
                svc: Some(Svc::Stopped {
                    start: "demand".to_string(),
                }),
                start: "demand".to_string(),
                listeners: HashMap::new(),
                rules: Vec::new(),
                feature: false,
                config_valid: true,
                config: "Port 22\nPasswordAuthentication yes\n".to_string(),
                files: HashMap::new(),
                fail_start: false,
                fail_stop: false,
            }),
        }
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, FakeSystem> {
        self.inner.lock().unwrap()
    }

    /// 模拟“用户已经手动开着 SSH”。
    pub fn pre_enabled(&self, start: &str) {
        let mut state = self.lock();
        state.svc = Some(Svc::Running {
            start: start.to_string(),
        });
        state.start = start.to_string();
        state.listeners.insert(22, (4242, "sshd.exe".to_string()));
    }

    /// 模拟端口被别的进程占用。
    pub fn occupy(&self, port: u16, pid: u32, process: &str) {
        self.lock()
            .listeners
            .insert(port, (pid, process.to_string()));
    }
}

impl Runner for Fake {
    fn run(&self, program: &str, args: &[&str]) -> std::io::Result<Output> {
        let mut state = self.lock();
        let joined = args.join(" ");
        let ok = |stdout: &str| {
            Ok(Output {
                code: 0,
                stdout: stdout.to_string(),
                stderr: String::new(),
            })
        };
        let err = |code: i32, stderr: &str| {
            Ok(Output {
                code,
                stdout: String::new(),
                stderr: stderr.to_string(),
            })
        };

        match program {
            "sc.exe" if joined.starts_with("query") => match &state.svc {
                Some(Svc::Running { .. }) => ok("STATE : 4  RUNNING"),
                Some(Svc::Stopped { .. }) => ok("STATE : 1  STOPPED"),
                None => err(1060, "The specified service does not exist"),
            },
            "sc.exe" if joined.starts_with("qc") => match &state.svc {
                None => err(1060, "The specified service does not exist"),
                Some(_) => ok(&format!("START_TYPE : {}", state.start.to_uppercase())),
            },
            "sc.exe" if joined.starts_with("config") => {
                let value = args
                    .iter()
                    .position(|arg| arg.starts_with("start="))
                    .map(|index| {
                        let inline = args[index]["start=".len()..].trim();
                        if inline.is_empty() {
                            args.get(index + 1).copied().unwrap_or("").trim()
                        } else {
                            inline
                        }
                    })
                    .unwrap_or("");
                state.start = value.to_string();
                ok("")
            }
            "sc.exe" if joined.starts_with("start") => {
                if state.fail_start {
                    return err(1, "start failed");
                }
                match state.svc {
                    Some(Svc::Running { .. }) => err(1056, "already running"),
                    None => err(1060, "missing"),
                    Some(Svc::Stopped { .. }) => {
                        let port = configured_port(&state.config);
                        state.svc = Some(Svc::Running {
                            start: state.start.clone(),
                        });
                        state.listeners.insert(port, (4242, "sshd.exe".to_string()));
                        ok("")
                    }
                }
            }
            "sc.exe" if joined.starts_with("stop") => {
                if state.fail_stop {
                    return err(1, "stop failed");
                }
                match state.svc {
                    Some(Svc::Running { .. }) => {
                        state.svc = Some(Svc::Stopped {
                            start: state.start.clone(),
                        });
                        state.listeners.clear();
                        ok("")
                    }
                    _ => err(1062, "not started"),
                }
            }
            "dism.exe" if joined.contains("get-featureinfo") => {
                let value = if state.feature { "Installed" } else { "NotPresent" };
                ok(&format!("Feature Name : OpenSSH.Server~~~~0.0.1.0\r\nState : {value}"))
            }
            "dism.exe" if joined.contains("add-capability") => {
                state.feature = true;
                state.svc = Some(Svc::Stopped {
                    start: "demand".to_string(),
                });
                ok("")
            }
            "cmd.exe" => {
                let exists = state.svc.is_some();
                Ok(Output {
                    code: if exists { 0 } else { 1 },
                    stdout: String::new(),
                    stderr: String::new(),
                })
            }
            "netstat.exe" => {
                let mut text = String::new();
                for (port, (pid, _)) in state.listeners.iter() {
                    text.push_str(&format!(
                        "  TCP    0.0.0.0:{port}    0.0.0.0:0    LISTENING    {pid}\n"
                    ));
                }
                ok(&text)
            }
            "tasklist.exe" => {
                let pid = args
                    .iter()
                    .find_map(|arg| arg.strip_prefix("PID eq "))
                    .and_then(|value| value.parse::<u32>().ok());
                let name = pid
                    .and_then(|pid| {
                        state
                            .listeners
                            .values()
                            .find(|(owner, _)| *owner == pid)
                            .map(|(_, name)| name.clone())
                    })
                    .unwrap_or_else(|| "unknown.exe".to_string());
                let pid_text = pid.map(|value| value.to_string()).unwrap_or_default();
                ok(&format!("\"{name}\",\"{pid_text}\",\"Console\",\"1\",\"1,024 K\"\r\n"))
            }
            "netsh.exe" if joined.contains("add") => {
                if let Some(name) = args.iter().find_map(|arg| arg.strip_prefix("name=")) {
                    state.rules.push(name.to_string());
                }
                ok("")
            }
            "netsh.exe" if joined.contains("delete") => {
                if let Some(name) = args.iter().find_map(|arg| arg.strip_prefix("name=")) {
                    state.rules.retain(|rule| rule != name);
                }
                ok("")
            }
            // 和真实 netsh 一致：找不到规则时退出码非 0（这里是 1）。
            "netsh.exe" => {
                let name = args.iter().find_map(|arg| arg.strip_prefix("name="));
                let exists = name.is_some_and(|name| state.rules.iter().any(|rule| rule == name));
                if exists {
                    ok("Rule exists")
                } else {
                    err(1, "No rules match the specified criteria.")
                }
            }
            "ssh-keygen.exe" => ok("256 SHA256:FAKE abc@host (ED25519)"),
            _ if joined.ends_with("-t") => {
                if state.config_valid {
                    ok("")
                } else {
                    err(1, "config invalid")
                }
            }
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("unexpected command {program} {joined}"),
            )),
        }
    }
}

impl ConfigIo for Fake {
    fn read(&self, path: &str) -> std::io::Result<String> {
        let state = self.lock();
        if path == "config" {
            return Ok(state.config.clone());
        }
        state
            .files
            .get(path)
            .cloned()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "missing"))
    }

    fn write(&self, path: &str, content: &str) -> std::io::Result<()> {
        let mut state = self.lock();
        if path == "config" {
            state.config = content.to_string();
            return Ok(());
        }
        state.files.insert(path.to_string(), content.to_string());
        Ok(())
    }

    fn copy(&self, from: &str, to: &str) -> std::io::Result<()> {
        let value = ConfigIo::read(self, from)?;
        ConfigIo::write(self, to, &value)
    }

    fn remove(&self, path: &str) -> std::io::Result<()> {
        self.lock().files.remove(path);
        Ok(())
    }
}

impl StateIo for Fake {
    fn read(&self, path: &str) -> std::io::Result<String> {
        ConfigIo::read(self, path)
    }

    fn write(&self, path: &str, content: &str) -> std::io::Result<()> {
        ConfigIo::write(self, path, content)
    }
}

/// 假 sshd 实际监听的端口：托管块里的端口优先，否则取最后一条 active `Port`。
fn configured_port(config: &str) -> u16 {
    let mut managed = None;
    let mut last = None;
    for line in config.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("Port ") {
            if let Ok(port) = value.trim().parse::<u16>() {
                last = Some(port);
            }
        }
    }
    if let Some(port) = crate::config::managed_port(config) {
        managed = Some(port);
    }
    managed.or(last).unwrap_or(22)
}
