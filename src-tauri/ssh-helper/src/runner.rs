//! 系统命令执行抽象。
//!
//! helper 只通过固定程序名 + 固定 argv 调用系统工具（`sc.exe`、`dism.exe`、`netsh.exe`、
//! `msiexec.exe`、`netstat.exe`、`tasklist.exe`、`sshd.exe`），不拼 shell 字符串，
//! 也不接受调用方传入的任何程序名或参数。

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

pub trait Runner: Send + Sync {
    fn run(&self, program: &str, args: &[&str]) -> std::io::Result<Output>;
}

/// 真实执行：绝对路径优先，避免被 PATH 劫持。
pub struct SystemRunner;

impl Runner for SystemRunner {
    fn run(&self, program: &str, args: &[&str]) -> std::io::Result<Output> {
        let output = Command::new(program).args(args).output()?;
        Ok(Output {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}
