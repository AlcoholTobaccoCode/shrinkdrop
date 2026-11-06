//! shrinkdrop SSH helper：Windows 特权辅助服务。
//!
//! - `helper`：固定动词的业务核心（无平台副作用，可在任何平台单测）
//! - `sshd`：`sc.exe`/`dism.exe`/`netsh.exe` 固定参数封装与输出解析
//! - `config`：`sshd_config` 托管块（换端口而非加端口，改前备份、失败回滚）
//! - `state`：状态文件、所有权与生命周期规则
//! - `runner`：命令执行抽象
//!
//! Windows 专属的管道 ACL/调用方鉴权在 `pipe.rs`，服务外壳在 `main.rs`。

pub mod bundled;
pub mod diag;
pub mod config;
pub mod helper;
pub mod runner;
pub mod session;
pub mod sshd;
pub mod state;

#[cfg(windows)]
pub mod pipe;

#[cfg(any(test, feature = "testing"))]
pub mod testing;

#[cfg(test)]
mod tests;
