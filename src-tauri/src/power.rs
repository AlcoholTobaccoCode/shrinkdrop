//! macOS 合盖/空闲休眠抑制。
//!
//! 通过 `caffeinate -i` 子进程阻止空闲休眠：它只阻止系统因空闲进入睡眠，
//! 不改变用户的节能设置，也不拦截屏幕锁定。进程随开关或应用退出结束。

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// 空闲休眠抑制器；非 macOS 平台上所有操作都是空操作。
pub struct SleepInhibitor {
    child: Mutex<Option<Child>>,
}

impl Default for SleepInhibitor {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }
}

impl SleepInhibitor {
    /// 当前平台是否支持该功能。
    pub const SUPPORTED: bool = cfg!(target_os = "macos");

    /// 按设置启用或停用；重复调用是幂等的。
    pub fn apply(&self, enabled: bool) -> Result<(), String> {
        if !Self::SUPPORTED {
            return Ok(());
        }
        let mut guard = self.child.lock().map_err(|_| "休眠状态不可用".to_string())?;
        if enabled {
            if guard.as_mut().is_some_and(|child| matches!(child.try_wait(), Ok(None))) {
                return Ok(());
            }
            // 上一个进程已退出（例如被系统回收），先清理再重启。
            *guard = None;
            let child = Command::new("/usr/bin/caffeinate")
                .arg("-i")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| "无法启动系统防休眠进程".to_string())?;
            *guard = Some(child);
            return Ok(());
        }
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    /// 应用退出时调用，确保不留下孤儿进程。
    pub fn release(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for SleepInhibitor {
    /// 兜底：进程退出或状态被丢弃时也要结束子进程，避免留下孤儿。
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 读取当前持有的子进程 PID；没有子进程时为 None。
    fn held_pid(inhibitor: &SleepInhibitor) -> Option<u32> {
        let guard = inhibitor.child.lock().unwrap();
        guard.as_ref().map(|child| child.id())
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
    #[cfg(target_os = "macos")]
    fn enabling_spawns_one_inhibitor_and_disabling_removes_it() {
        let inhibitor = SleepInhibitor::default();
        inhibitor.apply(false).unwrap();
        assert_eq!(held_pid(&inhibitor), None);

        inhibitor.apply(true).unwrap();
        let pid = held_pid(&inhibitor).expect("inhibitor should be running");
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(is_alive(pid));

        // 重复启用不应再起第二个进程。
        inhibitor.apply(true).unwrap();
        assert_eq!(held_pid(&inhibitor), Some(pid));

        inhibitor.apply(false).unwrap();
        assert_eq!(held_pid(&inhibitor), None);
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!is_alive(pid), "disabled inhibitor must not linger");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn release_cleans_up_without_explicit_disable() {
        let inhibitor = SleepInhibitor::default();
        inhibitor.apply(true).unwrap();
        let pid = held_pid(&inhibitor).expect("inhibitor should be running");
        inhibitor.release();
        assert_eq!(held_pid(&inhibitor), None);
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!is_alive(pid), "released inhibitor must not linger");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn exited_child_is_replaced_on_reenable() {
        let inhibitor = SleepInhibitor::default();
        inhibitor.apply(true).unwrap();
        let first = held_pid(&inhibitor).expect("inhibitor should be running");
        // 模拟子进程被系统回收。
        if let Ok(mut guard) = inhibitor.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        inhibitor.apply(true).unwrap();
        let second = held_pid(&inhibitor).expect("inhibitor should restart");
        assert_ne!(first, second);
        inhibitor.release();
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn dropping_the_inhibitor_ends_the_child() {
        let pid = {
            let inhibitor = SleepInhibitor::default();
            inhibitor.apply(true).unwrap();
            let pid = held_pid(&inhibitor).expect("inhibitor should be running");
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
        assert!(inhibitor.apply(true).is_ok());
        assert!(inhibitor.apply(false).is_ok());
        inhibitor.release();
    }
}
