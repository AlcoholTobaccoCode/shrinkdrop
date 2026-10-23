//! macOS 休眠抑制，三档：
//!
//! - `Off`：不做任何事，系统按自己的节能设置休眠。
//! - `Idle`：`caffeinate -i`，阻止系统因空闲休眠，显示器仍可关闭。
//! - `Always`：`caffeinate -d -i -s` 加上 `pmset -a disablesleep 1`。
//!   只有 `disablesleep` 能阻止合盖休眠，它需要管理员授权，并且是**系统级**设置，
//!   所以退出应用或降档时必须恢复为 0。
//!
//! 崩溃兜底：成功开启 `disablesleep` 后写标记文件；下次启动若标记存在但设置已不是
//! `Always`，说明上次没有正常恢复，此时重新执行恢复。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::sync::Mutex;

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
    /// 当前子进程使用的参数，用于判断档位变化时是否需要重启。
    args: Mutex<Option<Vec<&'static str>>>,
    /// 标记文件：存在表示本应用当前把系统 `disablesleep` 设为 1。
    marker: Mutex<Option<PathBuf>>,
}

impl Default for SleepInhibitor {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            args: Mutex::new(None),
            marker: Mutex::new(None),
        }
    }
}

impl SleepInhibitor {
    pub const SUPPORTED: bool = cfg!(target_os = "macos");

    /// 绑定标记文件位置；在应用启动时调用一次。
    pub fn bind_marker(&self, path: PathBuf) {
        if let Ok(mut guard) = self.marker.lock() {
            *guard = Some(path);
        }
    }

    /// 应用启动时调用：若上次异常退出留下了 `disablesleep`，按当前档位纠正。
    pub fn reconcile(&self, level: KeepAwake) -> Result<(), String> {
        if !Self::SUPPORTED {
            return Ok(());
        }
        let marked = self.marker_path().is_some_and(|path| path.exists());
        if marked && level != KeepAwake::Always {
            // 上次没有正常恢复，这里补一次；需要管理员授权。
            self.set_system_sleep_disabled(false)?;
        }
        self.apply(level)
    }

    /// 切换到指定档位；重复调用是幂等的。
    pub fn apply(&self, level: KeepAwake) -> Result<(), String> {
        if !Self::SUPPORTED {
            return Ok(());
        }
        if level == KeepAwake::Always {
            // 先确认系统级设置，避免 caffeinate 起来了但合盖仍休眠。
            self.set_system_sleep_disabled(true)?;
        }
        self.set_caffeinate(level)?;
        if level != KeepAwake::Always {
            self.set_system_sleep_disabled(false)?;
        }
        Ok(())
    }

    /// 应用退出时调用：结束子进程并恢复系统休眠设置。
    pub fn release(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        if Self::SUPPORTED && self.marker_path().is_some_and(|path| path.exists()) {
            // 退出路径不弹授权框：若当前已有 root 缓存（刚授权过）会成功，
            // 否则保留标记，下次启动 reconcile 再恢复。
            let _ = self.set_system_sleep_disabled(false);
        }
    }

    fn marker_path(&self) -> Option<PathBuf> {
        self.marker.lock().ok().and_then(|guard| guard.clone())
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
        // 档位变化时需要重启子进程以应用新参数。
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

    /// 读取并设置系统级 `disablesleep`；需要管理员授权时会弹出系统密码框。
    fn set_system_sleep_disabled(&self, disabled: bool) -> Result<(), String> {
        if self.system_sleep_disabled() == Some(disabled) {
            self.sync_marker(disabled);
            return Ok(());
        }
        let value = if disabled { "1" } else { "0" };
        let script = format!(
            "do shell script \"/usr/bin/pmset -a disablesleep {value}\" with administrator privileges"
        );
        let output = Command::new("/usr/bin/osascript")
            .args(["-e", &script])
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

/// osascript 授权失败时给用户可读的原因。
fn privilege_error(stderr: &str) -> String {
    // -128 是用户点击取消的标准错误码。
    if stderr.contains("-128") || stderr.to_lowercase().contains("cancel") {
        "已取消管理员授权，系统休眠设置未修改".to_string()
    } else {
        "修改系统休眠设置失败，请重试".to_string()
    }
}

impl Drop for SleepInhibitor {
    /// 兜底：状态被丢弃时也要结束子进程，避免留下孤儿。
    fn drop(&mut self) {
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
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[test]
    fn cancelled_authorization_is_reported_separately() {
        assert_eq!(
            privilege_error("execution error: User canceled. (-128)"),
            "已取消管理员授权，系统休眠设置未修改"
        );
        assert_eq!(
            privilege_error("execution error: something else"),
            "修改系统休眠设置失败，请重试"
        );
    }

    #[test]
    fn marker_tracks_system_setting_state() {
        let dir = std::env::temp_dir().join(format!("shrinkdrop-marker-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("keep-awake.lock");
        let _ = std::fs::remove_file(&marker);
        let inhibitor = SleepInhibitor::default();
        inhibitor.bind_marker(marker.clone());

        inhibitor.sync_marker(true);
        assert!(marker.exists());
        inhibitor.sync_marker(false);
        assert!(!marker.exists());
        let _ = std::fs::remove_dir_all(&dir);
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
            let parsed: KeepAwake = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed, level);
        }
        assert_eq!(serde_json::to_string(&KeepAwake::Always).unwrap(), "\"always\"");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn idle_level_runs_one_caffeinate_and_off_removes_it() {
        let inhibitor = SleepInhibitor::default();
        inhibitor.set_caffeinate(KeepAwake::Off).unwrap();
        assert_eq!(held_pid(&inhibitor), None);

        inhibitor.set_caffeinate(KeepAwake::Idle).unwrap();
        let pid = held_pid(&inhibitor).expect("idle should spawn caffeinate");
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(is_alive(pid));
        assert_eq!(inhibitor.current_args().as_deref(), Some(&["-i"][..]));

        inhibitor.set_caffeinate(KeepAwake::Off).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!is_alive(pid), "off must stop the child");
        assert_eq!(held_pid(&inhibitor), None);
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
        inhibitor.release();
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
        std::thread::sleep(std::time::Duration::from_millis(200));
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
