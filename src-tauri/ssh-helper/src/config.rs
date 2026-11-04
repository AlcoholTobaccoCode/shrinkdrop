//! `sshd_config` 的托管块：只改带标记的 `Port` 行，改前备份，校验失败回滚。
//!
//! 关键约束：OpenSSH 允许多条 `Port` 同时监听，所以“换端口”必须**注释掉已有的 active
//! `Port` 行**，不能只是追加一行，否则 22 会继续开着。

use shrinkdrop_ssh_core::ErrorCode;

pub const BEGIN: &str = "# shrinkdrop begin";
pub const END: &str = "# shrinkdrop end";

/// 移除托管块（幂等）。
pub fn strip_managed(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut inside = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == BEGIN {
            inside = true;
            continue;
        }
        if trimmed == END {
            inside = false;
            continue;
        }
        if inside {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// 把已有 active `Port` 行注释掉（保留注释与缩进形式），返回新内容。
pub fn comment_active_ports(content: &str) -> String {
    content
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            let is_active = trimmed
                .strip_prefix("Port")
                .or_else(|| trimmed.strip_prefix("port"))
                .is_some_and(|rest| {
                    !rest.is_empty()
                        && rest.starts_with(|c: char| c.is_whitespace())
                        && rest.trim().chars().next().is_some_and(|c| c.is_ascii_digit())
                });
            if is_active {
                format!("# shrinkdrop: {trimmed}")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 生成带托管块的新配置。
pub fn apply_port(content: &str, port: u16) -> String {
    let base = strip_managed(content);
    let commented = comment_active_ports(&base);
    let mut out = commented;
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(BEGIN);
    out.push('\n');
    out.push_str(&format!("Port {port}\n"));
    out.push_str(END);
    out.push('\n');
    out
}

/// 配置当前实际生效的端口：托管块优先，否则最后一条 active `Port`，都没有时是 22。
pub fn effective_port(content: &str) -> u16 {
    if let Some(port) = managed_port(content) {
        return port;
    }
    content
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim_start();
            let rest = trimmed
                .strip_prefix("Port")
                .or_else(|| trimmed.strip_prefix("port"))?;
            if !rest.starts_with(|c: char| c.is_whitespace()) {
                return None;
            }
            rest.trim().parse::<u16>().ok()
        })
        .last()
        .unwrap_or(22)
}

/// 从配置里读出托管块声明的端口。
pub fn managed_port(content: &str) -> Option<u16> {
    let mut inside = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == BEGIN {
            inside = true;
            continue;
        }
        if trimmed == END {
            inside = false;
        }
        if inside {
            if let Some(value) = trimmed.strip_prefix("Port") {
                return value.trim().parse::<u16>().ok();
            }
        }
    }
    None
}

pub trait ConfigIo: Send + Sync {
    fn read(&self, path: &str) -> std::io::Result<String>;
    fn write(&self, path: &str, content: &str) -> std::io::Result<()>;
    fn copy(&self, from: &str, to: &str) -> std::io::Result<()>;
    fn remove(&self, path: &str) -> std::io::Result<()>;
}

pub struct FsConfigIo;

impl ConfigIo for FsConfigIo {
    fn read(&self, path: &str) -> std::io::Result<String> {
        std::fs::read_to_string(path)
    }

    fn write(&self, path: &str, content: &str) -> std::io::Result<()> {
        std::fs::write(path, content)
    }

    fn copy(&self, from: &str, to: &str) -> std::io::Result<()> {
        std::fs::copy(from, to).map(|_| ())
    }

    fn remove(&self, path: &str) -> std::io::Result<()> {
        std::fs::remove_file(path)
    }
}

/// 改端口的完整流程：备份 → 写托管块 → 校验 → 失败回滚。
pub fn set_port(
    io: &dyn ConfigIo,
    path: &str,
    port: u16,
    validate: impl Fn() -> Result<(), ErrorCode>,
) -> Result<(), ErrorCode> {
    let original = io.read(path).map_err(|_| ErrorCode::ServiceMissing)?;
    let backup = format!("{path}.shrinkdrop-backup");
    // 备份是否存在只问注入的 IO，不直接探文件系统（否则测试/替换实现会被绕过）。
    if io.read(&backup).is_err() {
        io.copy(path, &backup).map_err(|_| ErrorCode::Internal)?;
    }
    let updated = apply_port(&original, port);
    io.write(path, &updated).map_err(|_| ErrorCode::Internal)?;
    if let Err(error) = validate() {
        let _ = io.write(path, &original);
        let _ = io.remove(&backup);
        return Err(error);
    }
    Ok(())
}

/// 还原备份（卸载/关闭时用），没有备份就什么都不做。
pub fn restore_backup(io: &dyn ConfigIo, path: &str) -> Result<(), ErrorCode> {
    let backup = format!("{path}.shrinkdrop-backup");
    let Ok(content) = io.read(&backup) else {
        return Ok(());
    };
    io.write(path, &content).map_err(|_| ErrorCode::Internal)?;
    let _ = io.remove(&backup);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryIo {
        files: Mutex<HashMap<String, String>>,
    }

    impl ConfigIo for MemoryIo {
        fn read(&self, path: &str) -> std::io::Result<String> {
            self.files
                .lock()
                .unwrap()
                .get(path)
                .cloned()
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "missing"))
        }

        fn write(&self, path: &str, content: &str) -> std::io::Result<()> {
            self.files
                .lock()
                .unwrap()
                .insert(path.to_string(), content.to_string());
            Ok(())
        }

        fn copy(&self, from: &str, to: &str) -> std::io::Result<()> {
            let value = self.read(from)?;
            self.write(to, &value)
        }

        fn remove(&self, path: &str) -> std::io::Result<()> {
            self.files.lock().unwrap().remove(path);
            Ok(())
        }
    }

    const BASE: &str = "Port 22\nPasswordAuthentication yes\n";

    #[test]
    fn applying_a_port_comments_the_active_port() {
        let updated = apply_port(BASE, 2222);
        assert!(updated.contains("# shrinkdrop: Port 22"), "22 必须被注释掉");
        assert!(updated.contains("Port 2222"));
        assert!(!updated.contains("\nPort 22\n"));
        assert_eq!(managed_port(&updated), Some(2222));
    }

    #[test]
    fn applying_twice_is_idempotent() {
        let once = apply_port(BASE, 2222);
        let twice = apply_port(&once, 2222);
        assert_eq!(once, twice);
        assert_eq!(twice.matches(BEGIN).count(), 1);
    }

    #[test]
    fn switching_ports_replaces_the_managed_block() {
        let first = apply_port(BASE, 2222);
        let second = apply_port(&first, 2200);
        assert_eq!(managed_port(&second), Some(2200));
        assert_eq!(second.matches("Port 2222").count(), 0, "旧端口不应残留");
        assert_eq!(second.matches(BEGIN).count(), 1);
    }

    #[test]
    fn already_commented_port_is_untouched() {
        let content = "#Port 22\nPasswordAuthentication yes\n";
        let updated = apply_port(content, 2222);
        assert!(updated.contains("#Port 22"));
        assert_eq!(managed_port(&updated), Some(2222));
    }

    #[test]
    fn failed_validation_restores_the_original() {
        let io = MemoryIo::default();
        io.write(CONFIG_PATH_TEST, BASE).unwrap();
        let result = set_port(&io, CONFIG_PATH_TEST, 2222, || Err(ErrorCode::ServiceStartFailed));
        assert_eq!(result, Err(ErrorCode::ServiceStartFailed));
        assert_eq!(io.read(CONFIG_PATH_TEST).unwrap(), BASE);
        assert!(io.read(&format!("{CONFIG_PATH_TEST}.shrinkdrop-backup")).is_err());
    }

    #[test]
    fn successful_change_keeps_a_backup_and_restore_undoes_it() {
        let io = MemoryIo::default();
        io.write(CONFIG_PATH_TEST, BASE).unwrap();
        set_port(&io, CONFIG_PATH_TEST, 2222, || Ok(())).unwrap();
        assert_eq!(managed_port(&io.read(CONFIG_PATH_TEST).unwrap()), Some(2222));

        restore_backup(&io, CONFIG_PATH_TEST).unwrap();
        assert_eq!(io.read(CONFIG_PATH_TEST).unwrap(), BASE);
    }

    #[test]
    fn effective_port_prefers_the_managed_block() {
        assert_eq!(effective_port("Port 22\n"), 22);
        assert_eq!(effective_port("#Port 22\n"), 22, "注释掉的 Port 不生效");
        assert_eq!(effective_port("Port 2222\nPort 22\n"), 22);
        let managed = apply_port(BASE, 2222);
        assert_eq!(effective_port(&managed), 2222);
    }

    #[test]
    fn restore_without_backup_is_a_noop() {
        let io = MemoryIo::default();
        io.write(CONFIG_PATH_TEST, BASE).unwrap();
        assert_eq!(restore_backup(&io, CONFIG_PATH_TEST), Ok(()));
        assert_eq!(io.read(CONFIG_PATH_TEST).unwrap(), BASE);
    }

    const CONFIG_PATH_TEST: &str = r"C:\ProgramData\ssh\sshd_config";
}
