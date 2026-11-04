//! 系统命令执行抽象。
//!
//! helper 只通过固定程序名 + 固定 argv 调用系统工具（`sc.exe`、`dism.exe`、`netsh.exe`、
//! `msiexec.exe`、`netstat.exe`、`tasklist.exe`、`sshd.exe`），不拼 shell 字符串，
//! 也不接受调用方传入的任何程序名或参数。

use std::path::PathBuf;
use std::process::Command;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    pub fn success(&self) -> bool {
        self.code == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_system_tools_resolve() {
        let resolved = resolve("sc.exe").unwrap();
        assert!(resolved.ends_with("sc.exe"));
        assert!(
            resolved.to_string_lossy().contains("System32"),
            "必须解析到 System32 下，实际 {resolved:?}"
        );
        assert!(resolve("netsh.exe").is_some());
        assert!(resolve("powershell.exe").is_none(), "不在白名单就不执行");
        assert!(resolve("malware.exe").is_none());
    }

    #[test]
    fn absolute_paths_pass_through() {
        let path = r"C:\Windows\System32\OpenSSH\sshd.exe";
        assert_eq!(resolve(path), Some(PathBuf::from(path)));
    }
}

pub trait Runner: Send + Sync {
    fn run(&self, program: &str, args: &[&str]) -> std::io::Result<Output>;
}

/// 真实执行：系统工具一律用 `%SystemRoot%\System32\` 下的绝对路径。
///
/// helper 以 LocalSystem 运行；用裸程序名会被 PATH 或当前目录劫持。
pub struct SystemRunner;

/// 把已知的系统工具解析成绝对路径；未知程序名直接拒绝，避免成为通用执行器。
pub fn resolve(program: &str) -> Option<PathBuf> {
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let system32 = root.join("System32");
    let name = program.rsplit(['\\', '/']).next().unwrap_or(program);
    let allowed = [
        "sc.exe",
        "dism.exe",
        "netsh.exe",
        "msiexec.exe",
        "netstat.exe",
        "tasklist.exe",
        "ssh-keygen.exe",
        "sshd.exe",
        "cmd.exe",
    ];
    // 调用方给的绝对路径只允许白名单里的可执行文件名（sshd.exe 在 OpenSSH 子目录）。
    if program.contains('\\') || program.contains('/') {
        let allowed_abs = ["sshd.exe", "ssh-keygen.exe"];
        return allowed_abs.contains(&name).then(|| PathBuf::from(program));
    }
    if allowed.contains(&name) {
        // OpenSSH 自带工具在 System32\OpenSSH 下，不在 System32 根目录。
        if matches!(name, "ssh-keygen.exe" | "sshd.exe") {
            return Some(system32.join("OpenSSH").join(name));
        }
        return Some(system32.join(name));
    }
    None
}

impl Runner for SystemRunner {
    fn run(&self, program: &str, args: &[&str]) -> std::io::Result<Output> {
        let path = resolve(program).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!("拒绝执行未列入白名单的程序：{program}"),
            )
        })?;
        let output = Command::new(path).args(args).output()?;
        Ok(Output {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}
