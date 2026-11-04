//! Windows 传输层：命名管道 + 提权安装/卸载 helper 服务。
//!
//! 只在本机管道上通信，管道本身拒绝远程客户端（helper 侧
//! `PIPE_REJECT_REMOTE_CLIENTS`）。app 从不直接调用 `sc.exe`：所有 sshd 动作都在
//! helper 里，因此 app 的权限面只有“连接管道”和“弹一次 UAC”。

use std::io::{BufReader, Read};
use std::os::windows::io::FromRawHandle;

use shrinkdrop_ssh_core::ErrorCode;
use windows_sys::Win32::Foundation::{GetLastError, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING,
};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

use super::ipc::{Session, Transport};
use super::SshError;

pub const PIPE_NAME: &str = r"\\.\pipe\shrinkdrop-ssh-helper";
pub const SERVICE_NAME: &str = "ShrinkdropSshHelper";
const HELPER_EXE: &str = "shrinkdrop-ssh-helper.exe";
const ERROR_CANCELLED: u32 = 1223;

pub struct WindowsPipeTransport {
    helper_path: std::path::PathBuf,
}

impl WindowsPipeTransport {
    /// 优先用 app 同目录的 helper，其次是安装包资源目录。
    pub fn locate(resource_dir: Option<std::path::PathBuf>) -> Self {
        let beside_exe = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join(HELPER_EXE)));
        let path = beside_exe
            .filter(|path| path.exists())
            .or_else(|| resource_dir.map(|dir| dir.join(HELPER_EXE)))
            .unwrap_or_else(|| std::path::PathBuf::from(HELPER_EXE));
        Self { helper_path: path }
    }
}

fn pipe_unavailable(detail: &str) -> SshError {
    SshError::with_detail(ErrorCode::HelperUnavailable, detail)
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 打开本机管道；`\\.\pipe\*` 不是文件系统路径，只能靠 CreateFileW 判定存在。
fn open_pipe() -> Result<std::fs::File, SshError> {
    let name = wide(PIPE_NAME);
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let error = unsafe { GetLastError() };
        return Err(pipe_unavailable(&format!(
            "无法连接辅助服务（错误 {error}），请先在设置中安装"
        )));
    }
    Ok(unsafe { std::fs::File::from_raw_handle(handle) })
}

impl Transport for WindowsPipeTransport {
    fn open(&self) -> Result<Session, SshError> {
        let file = open_pipe()?;
        let writer = file
            .try_clone()
            .map_err(|_| pipe_unavailable("辅助服务连接不可用"))?;
        let reader: Box<dyn Read + Send> = Box::new(file);
        Session::open(
            Box::new(BufReader::new(reader)),
            Box::new(writer),
            env!("CARGO_PKG_VERSION"),
        )
    }

    fn installed(&self) -> bool {
        // 管道存在即服务在跑；服务已装但停止时返回 false，UI 据此提示“启动/安装”。
        open_pipe().is_ok()
    }

    fn install(&self) -> Result<(), SshError> {
        run_elevated(&self.helper_path, "--install-service")
    }

    fn uninstall(&self) -> Result<(), SshError> {
        run_elevated(&self.helper_path, "--uninstall-service")
    }
}

/// `ShellExecuteW ... "runas"`：由系统弹 UAC，app 自身不提权。
fn run_elevated(exe: &std::path::Path, argument: &str) -> Result<(), SshError> {
    if !exe.exists() {
        return Err(SshError::with_detail(
            ErrorCode::HelperUnavailable,
            format!("缺少辅助程序 {}", exe.display()),
        ));
    }
    let verb = wide("runas");
    let file = wide(&exe.display().to_string());
    let args = wide(argument);
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            args.as_ptr(),
            std::ptr::null(),
            SW_HIDE,
        )
    };
    // ShellExecuteW 返回 HINSTANCE：<= 32 表示失败。
    let code = result as isize;
    if code <= 32 {
        let error = unsafe { GetLastError() };
        return Err(SshError::with_detail(
            ErrorCode::NeedsAdmin,
            if error == ERROR_CANCELLED {
                "已取消管理员授权"
            } else {
                "无法启动辅助服务安装"
            },
        ));
    }
    Ok(())
}
