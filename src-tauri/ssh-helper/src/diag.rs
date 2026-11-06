//! helper 的诊断日志。
//!
//! 服务进程没有控制台，`eprintln!` 写不到任何地方 —— 之前服务为什么退出、谁被拒绝，
//! 用户和我们都看不到。这里把关键事件追加到固定路径，超过 1 MB 轮转一份。
//!
//! 只记录事件与错误码：不落凭据、不落 `authorized_keys`、不落用户输入。

use std::io::Write;
use std::path::Path;

pub const LOG_PATH: &str = r"C:\ProgramData\shrinkdrop\helper.log";
const MAX_BYTES: u64 = 1024 * 1024;

/// 追加一行；任何失败都静默（日志不能影响服务可用性）。
pub fn log(message: &str) {
    let _ = append(LOG_PATH, message);
}

fn append(path: &str, message: &str) -> std::io::Result<()> {
    if let Some(parent) = Path::new(path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0) > MAX_BYTES {
        // 轮转：只保留一份旧日志，避免无限增长。
        let _ = std::fs::rename(path, format!("{path}.1"));
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    writeln!(file, "{stamp} {message}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_instead_of_growing_without_bound() {
        let dir = std::env::temp_dir().join(format!("shrinkdrop-diag-{}", std::process::id()));
        let path = dir.join("helper.log");
        let path = path.to_str().unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        append(path, "first").unwrap();
        assert!(std::fs::read_to_string(path).unwrap().contains("first"));

        // 手动撑过上限，再写一次：旧内容应挪到 .1，主文件只剩新的一行。
        std::fs::write(path, "x".repeat(MAX_BYTES as usize + 1)).unwrap();
        append(path, "second").unwrap();
        let current = std::fs::read_to_string(path).unwrap();
        assert!(current.contains("second"));
        assert!(current.len() < 200, "轮转后主文件应重新开始，实际 {}", current.len());
        assert!(std::fs::metadata(format!("{path}.1")).unwrap().len() > MAX_BYTES);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
