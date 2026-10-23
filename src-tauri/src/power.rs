//! macOS 休眠抑制，三档：
//!
//! - `Off`：不做任何事，系统按自己的节能设置休眠。
//! - `Idle`：`caffeinate -i`，阻止系统因空闲休眠，显示器仍可关闭。
//! - `Always`：`caffeinate -d -i -s` 加上系统级 `pmset -a disablesleep 1`。
//!   只有 `disablesleep` 能阻止合盖休眠。
//!
//! `disablesleep` 需要 root。为避免每次切换都弹系统密码框，首次进入 `Always`
//! 时授权一次，启动一个常驻的 root helper 轮询状态文件；此后开关只改状态文件，
//! 不再请求授权。helper 只执行固定的 `pmset -a disablesleep 0|1`，不接收其它命令，
//! 并在应用进程消失时自动恢复为 0 后退出。
//!
//! 标记文件记录「本应用把系统设为 disablesleep=1」，用于崩溃或重启后的纠正。

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// root LaunchDaemon 的固定标签；同一台机器只允许一个实例。
const HELPER_LABEL: &str = "com.shrinkdrop.keepawake";
/// helper 脚本固定放在 root 拥有的目录，避免被同用户进程替换。
const HELPER_SCRIPT_PATH: &str = "/Library/Application Support/shrinkdrop/keep-awake-helper.sh";

/// 防休眠档位；旧版布尔值 true/false 分别迁移为 Idle/Off。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeepAwake {
    Off,
    Idle,
    Always,
}

impl Default for KeepAwake {
    fn default() -> Self {
        KeepAwake::Off
    }
}

impl<'de> Deserialize<'de> for KeepAwake {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // 兼容旧版 `keepAwake: true|false`，以及新版的字符串档位。
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Flag(bool),
            Level(String),
        }
        Ok(match Raw::deserialize(deserializer)? {
            Raw::Flag(true) => KeepAwake::Idle,
            Raw::Flag(false) => KeepAwake::Off,
            Raw::Level(value) => match value.as_str() {
                "idle" => KeepAwake::Idle,
                "always" => KeepAwake::Always,
                _ => KeepAwake::Off,
            },
        })
    }
}

pub struct SleepInhibitor {
    child: Mutex<Option<Child>>,
    /// 后台心跳线程：helper 连续读不到心跳就会恢复系统设置并退出。
    heartbeat: Mutex<Option<(Arc<AtomicBool>, JoinHandle<()>)>>,
    /// 当前子进程使用的参数，用于判断档位变化时是否需要重启。
    args: Mutex<Option<Vec<&'static str>>>,
    /// 状态目录：helper 状态文件、PID 文件与标记文件都放在这里。
    dir: Mutex<Option<PathBuf>>,
}

impl Default for SleepInhibitor {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            heartbeat: Mutex::new(None),
            args: Mutex::new(None),
            dir: Mutex::new(None),
        }
    }
}

impl SleepInhibitor {
    pub const SUPPORTED: bool = cfg!(target_os = "macos");

    /// 绑定状态目录；应用启动时调用一次。
    pub fn bind_dir(&self, dir: PathBuf) {
        if let Ok(mut guard) = self.dir.lock() {
            *guard = Some(dir);
        }
    }

    /// 应用启动时调用：若上次异常退出留下了 `disablesleep`，按当前档位纠正。
    pub fn reconcile(&self, level: KeepAwake) -> Result<(), String> {
        if !Self::SUPPORTED {
            return Ok(());
        }
        let marked = self.marker_path().is_some_and(|path| path.exists());
        if marked && level != KeepAwake::Always {
            // 上次没有正常恢复。没有常驻 helper 可用，只能直接请求一次授权。
            self.direct_set_system_sleep(false)?;
        }
        self.apply(level)
    }

    /// 切换到指定档位；重复调用是幂等的。
    pub fn apply(&self, level: KeepAwake) -> Result<(), String> {
        if !Self::SUPPORTED {
            return Ok(());
        }
        match level {
            KeepAwake::Off | KeepAwake::Idle => {
                self.set_caffeinate(level)?;
                self.set_system_sleep(false)?;
            }
            KeepAwake::Always => {
                // 先确保系统级设置生效，避免 caffeinate 起来了但合盖仍休眠。
                self.set_system_sleep(true)?;
                self.set_caffeinate(level)?;
            }
        }
        Ok(())
    }

    /// 应用退出时调用：结束子进程并恢复系统休眠设置。
    pub fn release(&self) {
        // 先停心跳，helper 会在几个周期后自行恢复系统设置；这里再尽力同步关闭一次。
        self.stop_heartbeat();
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        if Self::SUPPORTED && self.marker_path().is_some_and(|path| path.exists()) {
            // helper 仍在运行时这条写入免密生效；否则等下次启动 reconcile 再恢复。
            let _ = self.set_system_sleep(false);
        }
    }

    fn state_dir(&self) -> Option<PathBuf> {
        self.dir.lock().ok().and_then(|guard| guard.clone())
    }

    fn state_path(&self) -> Option<PathBuf> {
        self.state_dir().map(|dir| dir.join("keep-awake.state"))
    }

    fn helper_pid_path(&self) -> Option<PathBuf> {
        self.state_dir().map(|dir| dir.join("keep-awake.helper.pid"))
    }

    fn heartbeat_path(&self) -> Option<PathBuf> {
        self.state_dir().map(|dir| dir.join("keep-awake.beat"))
    }

    fn marker_path(&self) -> Option<PathBuf> {
        self.state_dir().map(|dir| dir.join("keep-awake.lock"))
    }

    /// 启动后台心跳线程；重复调用是幂等的。
    fn start_heartbeat(&self) {
        let Ok(mut slot) = self.heartbeat.lock() else {
            return;
        };
        if slot.is_some() {
            return;
        }
        let Some(path) = self.heartbeat_path() else {
            return;
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let running = Arc::new(AtomicBool::new(true));
        let flag = running.clone();
        let handle = std::thread::spawn(move || {
            while flag.load(Ordering::Relaxed) {
                let _ = std::fs::File::create(&path);
                std::thread::sleep(Duration::from_secs(1));
            }
        });
        *slot = Some((running, handle));
    }

    /// 停止心跳线程；helper 会在超时后自行恢复并退出。
    fn stop_heartbeat(&self) {
        if let Ok(mut slot) = self.heartbeat.lock() {
            if let Some((running, handle)) = slot.take() {
                running.store(false, Ordering::Relaxed);
                let _ = handle.join();
            }
        }
        if let Some(path) = self.heartbeat_path() {
            let _ = std::fs::remove_file(path);
        }
    }

    /// 启停 `caffeinate`：Idle 只挡空闲休眠，Always 额外挡显示器与系统休眠。
    fn set_caffeinate(&self, level: KeepAwake) -> Result<(), String> {
        let mut guard = self.child.lock().map_err(|_| "休眠状态不可用".to_string())?;
        let running = guard
            .as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(None)));
        if level == KeepAwake::Off {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            self.remember_args(&[]);
            return Ok(());
        }
        let args: &[&str] = if level == KeepAwake::Always {
            &["-d", "-i", "-s"]
        } else {
            &["-i"]
        };
        if running {
            if self.current_args().as_deref() == Some(args) {
                return Ok(());
            }
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        let child = Command::new("/usr/bin/caffeinate")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "无法启动系统防休眠进程".to_string())?;
        self.remember_args(args);
        *guard = Some(child);
        Ok(())
    }

    fn current_args(&self) -> Option<Vec<&'static str>> {
        self.args.lock().ok().and_then(|guard| guard.clone())
    }

    fn remember_args(&self, args: &[&'static str]) {
        if let Ok(mut guard) = self.args.lock() {
            *guard = Some(args.to_vec());
        }
    }

    /// 设置系统级 `disablesleep`：优先走已授权的 helper，必要时才请求授权。
    fn set_system_sleep(&self, disabled: bool) -> Result<(), String> {
        if self.system_sleep_disabled() == Some(disabled) {
            self.sync_marker(disabled);
            return Ok(());
        }
        if disabled || self.helper_running() {
            // 需要开启，或已有 helper 可以免密关闭。
            if disabled && !self.helper_running() {
                self.start_helper()?;
            }
            self.write_state(disabled)?;
            if self.wait_for_system_state(disabled) {
                self.sync_marker(disabled);
                return Ok(());
            }
            return Err("系统休眠设置没有生效，请重试".to_string());
        }
        // 没有 helper 却需要关闭：说明是上次残留，只能再授权一次。
        self.direct_set_system_sleep(disabled)
    }

    fn write_state(&self, disabled: bool) -> Result<(), String> {
        let Some(path) = self.state_path() else {
            return Err("休眠状态目录不可用".to_string());
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "无法创建状态目录".to_string())?;
        }
        let mut file = std::fs::File::create(&path).map_err(|_| "无法写入休眠状态".to_string())?;
        file.write_all(if disabled { b"1" } else { b"0" })
            .map_err(|_| "无法写入休眠状态".to_string())
    }

    /// 轮询等待系统设置同步；helper 每 300ms 读取一次状态文件。
    fn wait_for_system_state(&self, disabled: bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            if self.system_sleep_disabled() == Some(disabled) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(120));
        }
        false
    }

    /// 查询 LaunchDaemon 是否在运行；`launchctl print` 对 system 域无需 root。
    fn helper_running(&self) -> bool {
        Command::new("/bin/launchctl")
            .args(["print", &format!("system/{HELPER_LABEL}")])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    /// 请求一次管理员授权，安装并启动 root LaunchDaemon；之后切换免密。
    fn start_helper(&self) -> Result<(), String> {
        if self.helper_running() {
            return Ok(());
        }
        let (Some(state), Some(pid_file), Some(marker), Some(beat)) = (
            self.state_path(),
            self.helper_pid_path(),
            self.marker_path(),
            self.heartbeat_path(),
        ) else {
            return Err("休眠状态目录不可用".to_string());
        };
        // 先写好目标状态与心跳，daemon 启动后会立刻读取。
        self.write_state(true)?;
        self.start_heartbeat();

        // 脚本内容直接交给 root 写入 /Library，绝不经过用户可写目录：
        // 否则本机任意同用户进程都能改写脚本，等下次授权时以 root 执行。
        let uid = Command::new("/usr/bin/id")
            .arg("-u")
            .output()
            .ok()
            .and_then(|out| String::from_utf8_lossy(&out.stdout).trim().parse::<u32>().ok())
            .ok_or_else(|| "无法确定当前用户".to_string())?;
        let script = helper_script(&state, &beat, &pid_file, &marker, uid);
        let script_target = HELPER_SCRIPT_PATH;
        let plist = helper_plist(Path::new(script_target));
        let plist_target = format!("/Library/LaunchDaemons/{HELPER_LABEL}.plist");

        // 用 base64 传输脚本内容，避免引号与换行在 shell 里被重新解释。
        let encoded = base64(script.as_bytes());
        let command = format!(
            "printf %s {payload} | /usr/bin/base64 -D > {script}; \
             /usr/sbin/chown root:wheel {script}; /bin/chmod 755 {script}; \
             printf %s {plist_payload} | /usr/bin/base64 -D > {target}; \
             /usr/sbin/chown root:wheel {target}; /bin/chmod 644 {target}; \
             /bin/launchctl bootout system/{label} >/dev/null 2>&1; \
             /bin/launchctl bootstrap system {target}",
            payload = shell_quote(&encoded),
            script = shell_quote(script_target),
            plist_payload = shell_quote(&base64(plist.as_bytes())),
            target = shell_quote(&plist_target),
            label = HELPER_LABEL,
        );
        let apple = format!(
            "do shell script \"{}\" with administrator privileges",
            command.replace('\\', "\\\\").replace('"', "\\\"")
        );
        let output = Command::new("/usr/bin/osascript")
            .args(["-e", &apple])
            .output()
            .map_err(|_| "无法请求管理员授权".to_string())?;
        if !output.status.success() {
            self.stop_heartbeat();
            let stderr = String::from_utf8_lossy(&output.stderr);
            eprintln!("keep-awake install failed: {stderr}");
            return Err(privilege_error(&stderr));
        }

        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            if self.helper_running() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(120));
        }
        Err("防休眠进程没有启动，请重试".to_string())
    }

    /// 没有 helper 时直接请求授权修改一次系统设置。
    fn direct_set_system_sleep(&self, disabled: bool) -> Result<(), String> {
        if self.system_sleep_disabled() == Some(disabled) {
            self.sync_marker(disabled);
            return Ok(());
        }
        let value = if disabled { "1" } else { "0" };
        let apple = format!(
            "do shell script \"/usr/bin/pmset -a disablesleep {value}\" with administrator privileges"
        );
        let output = Command::new("/usr/bin/osascript")
            .args(["-e", &apple])
            .output()
            .map_err(|_| "无法请求管理员授权".to_string())?;
        if !output.status.success() {
            return Err(privilege_error(&String::from_utf8_lossy(&output.stderr)));
        }
        if self.system_sleep_disabled() != Some(disabled) {
            return Err("系统休眠设置没有生效，请重试".to_string());
        }
        self.sync_marker(disabled);
        Ok(())
    }

    /// 读取 `pmset -g` 中的 SleepDisabled；读不到时返回 None。
    fn system_sleep_disabled(&self) -> Option<bool> {
        let Output { stdout, status, .. } = Command::new("/usr/bin/pmset").arg("-g").output().ok()?;
        if !status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&stdout);
        text.lines()
            .find_map(|line| line.trim().strip_prefix("SleepDisabled"))
            .and_then(|rest| rest.trim().parse::<u32>().ok())
            .map(|value| value == 1)
    }

    fn sync_marker(&self, disabled: bool) {
        let Some(path) = self.marker_path() else {
            return;
        };
        if disabled {
            let _ = std::fs::write(&path, b"1");
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// 常驻 helper：只响应状态文件里的 0/1；心跳消失后恢复并退出。
///
/// 安全边界：
/// - 脚本本身由 root 写入 /Library（见 `start_helper`），不经过用户可写目录；
/// - 运行前校验状态目录属于当前用户、且不是符号链接，避免 root 读他人可写文件；
/// - 只接受字面量 0/1，只执行固定命令。
fn helper_script(state: &Path, beat: &Path, pid_file: &Path, marker: &Path, uid: u32) -> String {
    format!(
        "STATE='{state}'\nBEAT='{beat}'\nPIDFILE='{pid_file}'\nMARKER='{marker}'\nOWNER={uid}\n\
         apply() {{ /usr/bin/pmset -a disablesleep \"$1\"; }}\n\
         owner_ok() {{\n\
         \x20 [ -f \"$STATE\" ] || return 0\n\
         \x20 [ -L \"$STATE\" ] && return 1\n\
         \x20 [ \"$(/usr/bin/stat -f %u \"$STATE\" 2>/dev/null)\" = \"$OWNER\" ] || return 1\n\
         \x20 return 0\n\
         }}\n\
         echo $$ > \"$PIDFILE\"\n\
         last=''\n\
         miss=0\n\
         while [ \"$miss\" -lt 8 ]; do\n\
         \x20 v=''\n\
         \x20 owner_ok && v=$(/bin/cat \"$STATE\" 2>/dev/null)\n\
         \x20 case \"$v\" in\n\
         \x20   0|1) if [ \"$v\" != \"$last\" ]; then apply \"$v\"; last=\"$v\"; fi ;;\n\
         \x20 esac\n\
         \x20 if [ -f \"$BEAT\" ]; then miss=0; /bin/rm -f \"$BEAT\"; else miss=$((miss+1)); fi\n\
         \x20 /bin/sleep 0.5\n\
         done\n\
         apply 0\n\
         /bin/rm -f \"$MARKER\" \"$PIDFILE\" \"$STATE\"\n",
        state = state.display(),
        beat = beat.display(),
        pid_file = pid_file.display(),
        marker = marker.display(),
        uid = uid,
    )
}

/// LaunchDaemon 配置：以 root 运行 /Library 下的 helper 脚本。
fn helper_plist(script: &Path) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\"><dict>\n\
         <key>Label</key><string>{label}</string>\n\
         <key>ProgramArguments</key><array>\n\
         <string>/bin/sh</string><string>{script}</string>\n\
         </array>\n\
         <key>RunAtLoad</key><true/>\n\
         <key>KeepAlive</key><false/>\n\
         </dict></plist>\n",
        label = HELPER_LABEL,
        script = script.display(),
    )
}

/// 标准 base64 编码，用于把脚本内容安全地传给 root shell。
fn base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) as usize & 63] as char);
        out.push(TABLE[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(triple >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[triple as usize & 63] as char } else { '=' });
    }
    out
}

/// 用单引号包裹 shell 参数；路径里的单引号按 POSIX 规则转义。
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// osascript 授权失败时给用户可读的原因。
fn privilege_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    // -128 是用户点击取消；-60005 是用户名或密码错误。
    if stderr.contains("-128") || lower.contains("cancel") {
        "已取消管理员授权，系统休眠设置未修改".to_string()
    } else if stderr.contains("-60005") || lower.contains("password") {
        "管理员用户名或密码不正确，系统休眠设置未修改".to_string()
    } else {
        "修改系统休眠设置失败，请重试".to_string()
    }
}

impl Drop for SleepInhibitor {
    /// 兜底：状态被丢弃时也要结束子进程与心跳，避免留下孤儿。
    fn drop(&mut self) {
        self.stop_heartbeat();
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn held_pid(inhibitor: &SleepInhibitor) -> Option<u32> {
        inhibitor
            .child
            .lock()
            .unwrap()
            .as_ref()
            .map(|child| child.id())
    }

    #[cfg(target_os = "macos")]
    fn is_alive(pid: u32) -> bool {
        Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[test]
    fn plist_points_at_the_helper_script_with_a_fixed_label() {
        let plist = helper_plist(Path::new("/tmp/a b/helper.sh"));
        assert!(plist.contains("<string>com.shrinkdrop.keepawake</string>"));
        assert!(plist.contains("<string>/bin/sh</string>"));
        assert!(plist.contains("<string>/tmp/a b/helper.sh</string>"));
        assert!(plist.contains("<key>RunAtLoad</key><true/>"));
        assert!(!plist.contains("<key>KeepAlive</key><true/>"));
    }

    #[test]
    fn helper_script_uses_fixed_paths_and_exits_with_app() {
        let script = helper_script(
            Path::new("/tmp/a b/state"),
            Path::new("/tmp/a b/beat"),
            Path::new("/tmp/a b/pid"),
            Path::new("/tmp/a b/marker"),
            501,
        );
        // 路径带空格时仍是单个 shell 单词。
        assert!(script.contains("STATE='/tmp/a b/state'"));
        assert!(script.contains("BEAT='/tmp/a b/beat'"));
        // 只接受 0/1，且只执行固定命令。
        assert!(script.contains("0|1)"));
        assert!(script.contains("/usr/bin/pmset -a disablesleep"));
        // 心跳消失后退出，而不是依赖不可靠的 PID 探测。
        assert!(script.contains("[ \"$miss\" -lt 8 ]"));
        assert!(script.contains("miss=$((miss+1))"));
        // 退出后恢复并清理。
        assert!(script.contains("apply 0"));
        assert!(script.contains("/bin/rm -f"));
        // root 只读取属于本用户、且不是符号链接的状态文件。
        assert!(script.contains("OWNER=501"));
        assert!(script.contains("[ -L \"$STATE\" ] && return 1"));
        assert!(script.contains("stat -f %u"));
    }

    #[test]
    fn helper_script_is_written_to_a_root_owned_path() {
        assert!(HELPER_SCRIPT_PATH.starts_with("/Library/"));
        assert!(!HELPER_SCRIPT_PATH.contains("Application Support/com.shrinkdrop"));
        let plist = helper_plist(Path::new(HELPER_SCRIPT_PATH));
        assert!(plist.contains(HELPER_SCRIPT_PATH));
    }

    #[test]
    fn cancelled_authorization_is_reported_separately() {
        assert_eq!(
            privilege_error("execution error: User canceled. (-128)"),
            "已取消管理员授权，系统休眠设置未修改"
        );
        assert_eq!(
            privilege_error("0:449: execution error: 管理员用户名或密码不正确。 (-60005)"),
            "管理员用户名或密码不正确，系统休眠设置未修改"
        );
        assert_eq!(
            privilege_error("execution error: something else"),
            "修改系统休眠设置失败，请重试"
        );
    }

    #[test]
    fn legacy_boolean_setting_migrates_to_idle() {
        let legacy_true: KeepAwake = serde_json::from_str("true").unwrap();
        let legacy_false: KeepAwake = serde_json::from_str("false").unwrap();
        assert_eq!(legacy_true, KeepAwake::Idle);
        assert_eq!(legacy_false, KeepAwake::Off);
    }

    #[test]
    fn level_names_round_trip() {
        for level in [KeepAwake::Off, KeepAwake::Idle, KeepAwake::Always] {
            let json = serde_json::to_string(&level).unwrap();
            assert_eq!(serde_json::from_str::<KeepAwake>(&json).unwrap(), level);
        }
        assert_eq!(serde_json::to_string(&KeepAwake::Always).unwrap(), "\"always\"");
    }

    #[test]
    fn state_and_marker_paths_live_in_the_bound_directory() {
        let dir = std::env::temp_dir().join(format!("shrinkdrop-state-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let inhibitor = SleepInhibitor::default();
        inhibitor.bind_dir(dir.clone());
        assert_eq!(inhibitor.state_path(), Some(dir.join("keep-awake.state")));
        assert_eq!(inhibitor.helper_pid_path(), Some(dir.join("keep-awake.helper.pid")));
        assert_eq!(inhibitor.marker_path(), Some(dir.join("keep-awake.lock")));

        inhibitor.sync_marker(true);
        assert!(dir.join("keep-awake.lock").exists());
        inhibitor.sync_marker(false);
        assert!(!dir.join("keep-awake.lock").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn idle_level_runs_one_caffeinate_and_off_removes_it() {
        let inhibitor = SleepInhibitor::default();
        inhibitor.set_caffeinate(KeepAwake::Off).unwrap();
        assert_eq!(held_pid(&inhibitor), None);

        inhibitor.set_caffeinate(KeepAwake::Idle).unwrap();
        let pid = held_pid(&inhibitor).expect("idle should spawn caffeinate");
        std::thread::sleep(Duration::from_millis(150));
        assert!(is_alive(pid));
        assert_eq!(inhibitor.current_args().as_deref(), Some(&["-i"][..]));

        inhibitor.set_caffeinate(KeepAwake::Off).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(!is_alive(pid), "off must stop the child");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn switching_from_idle_to_always_restarts_with_display_flags() {
        let inhibitor = SleepInhibitor::default();
        inhibitor.set_caffeinate(KeepAwake::Idle).unwrap();
        let idle_pid = held_pid(&inhibitor).unwrap();
        inhibitor.set_caffeinate(KeepAwake::Always).unwrap();
        let always_pid = held_pid(&inhibitor).unwrap();
        assert_ne!(idle_pid, always_pid, "flags changed so the child must restart");
        assert_eq!(
            inhibitor.current_args().as_deref(),
            Some(&["-d", "-i", "-s"][..])
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn dropping_the_inhibitor_ends_the_child() {
        let pid = {
            let inhibitor = SleepInhibitor::default();
            inhibitor.set_caffeinate(KeepAwake::Idle).unwrap();
            let pid = held_pid(&inhibitor).expect("child should be running");
            assert!(is_alive(pid));
            pid
        };
        std::thread::sleep(Duration::from_millis(200));
        assert!(!is_alive(pid), "dropped inhibitor must not leave an orphan");
    }

    #[test]
    fn unsupported_platform_is_a_no_op() {
        if SleepInhibitor::SUPPORTED {
            return;
        }
        let inhibitor = SleepInhibitor::default();
        assert!(inhibitor.apply(KeepAwake::Always).is_ok());
        assert!(inhibitor.apply(KeepAwake::Off).is_ok());
    }
}
