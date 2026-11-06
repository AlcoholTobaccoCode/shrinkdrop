//! 命名管道的访问控制与调用方鉴权（仅 Windows）。
//!
//! 两条独立的防线，缺一不可：
//! 1. 管道 DACL：只允许 SYSTEM、Administrators、安装者账户，并拒绝远程客户端；
//! 2. 每次连接校验调用方：与安装者同一账户（TokenUser 的 SID 比较，与提权状态无关），
//!    或属于 Administrators（含 UAC 过滤后 token 的 linked token），否则回 `needs_admin`。
//!
//! 之所以按“安装者账户”放行，而不是要求 app 自己提权：helper 本来就是替普通权限的
//! app 做特权操作的；DACL 已经把这根管道限定给 SYSTEM / Administrators / 安装者账户，
//! 安装那一刻的 UAC 就是授权点。要求每次操作都提权等于让 helper 失去意义。
//!
//! 只做这两件事：管道里没有任何“执行命令”的入口，见 `session.rs` 的固定动词。

use std::ffi::c_void;

use shrinkdrop_ssh_core::ErrorCode;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    CheckTokenMembership, CreateWellKnownSid, GetTokenInformation, TokenElevation, TokenLinkedToken,
    TokenUser, WinBuiltinAdministratorsSid, SECURITY_ATTRIBUTES, TOKEN_ELEVATION,
    TOKEN_LINKED_TOKEN, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::helper::Failure;

pub const PIPE_NAME: &str = r"\\.\pipe\shrinkdrop-ssh-helper";
pub fn wide_to_string(value: *const u16) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let mut length = 0usize;
    while unsafe { *value.add(length) } != 0 {
        length += 1;
        if length > 1024 {
            return None;
        }
    }
    let slice = unsafe { std::slice::from_raw_parts(value, length) };
    Some(String::from_utf16_lossy(slice))
}

/// `ERROR_PIPE_CONNECTED`：客户端在 `ConnectNamedPipe` 之前就已连上，属正常。
const ERROR_PIPE_CONNECTED: u32 = 535;
const ERROR_NO_SUCH_LOGON_SESSION: u32 = 1312;

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 安装时把当前（已提权的）管理员账户 SID 写进状态目录，供管道 DACL 使用。
pub fn install_sid() -> Result<String, Failure> {
    let mut token: HANDLE = std::ptr::null_mut();
    unsafe {
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(Failure::with_detail(
                ErrorCode::NeedsAdmin,
                "无法读取当前账户凭据",
            ));
        }
        let sid = token_user_sid(token);
        CloseHandle(token);
        sid.ok_or_else(|| Failure::with_detail(ErrorCode::NeedsAdmin, "无法读取当前账户 SID"))
    }
}

unsafe fn token_user_sid(token: HANDLE) -> Option<String> {
    let mut size = 0u32;
    GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
    if size == 0 {
        return None;
    }
    let mut buffer = vec![0u8; size as usize];
    if GetTokenInformation(
        token,
        TokenUser,
        buffer.as_mut_ptr() as *mut c_void,
        size,
        &mut size,
    ) == 0
    {
        return None;
    }
    let user = &*(buffer.as_ptr() as *const TOKEN_USER);
    sid_to_string(user.User.Sid)
}

unsafe fn sid_to_string(sid: *mut c_void) -> Option<String> {
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    let mut out: *mut u16 = std::ptr::null_mut();
    if ConvertSidToStringSidW(sid, &mut out) == 0 {
        return None;
    }
    let text = wide_to_string(out);
    windows_sys::Win32::Foundation::LocalFree(out as *mut c_void);
    text
}

/// 创建带 DACL 的管道：`D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;<installer>)`。
pub fn create_pipe(installer_sid: &str) -> Result<HANDLE, Failure> {
    let sddl = format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{installer_sid})");
    let sddl_wide = wide(&sddl);
    let mut descriptor: *mut c_void = std::ptr::null_mut();
    let mut descriptor_size = 0u32;
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_wide.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            &mut descriptor_size,
        ) == 0
        {
            return Err(Failure::with_detail(
                ErrorCode::Internal,
                "无法构造管道访问控制",
            ));
        }
    }
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let name = wide(PIPE_NAME);
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            shrinkdrop_ssh_core::MAX_FRAME as u32,
            shrinkdrop_ssh_core::MAX_FRAME as u32,
            0,
            &mut attributes,
        )
    };
    unsafe {
        windows_sys::Win32::Foundation::LocalFree(descriptor);
    }
    if handle == INVALID_HANDLE_VALUE {
        let error = unsafe { GetLastError() };
        return Err(Failure::with_detail(
            ErrorCode::Internal,
            format!("无法创建命名管道（错误 {error}）"),
        ));
    }
    Ok(handle)
}

/// 等待客户端连接。
pub fn accept(handle: HANDLE) -> Result<(), Failure> {
    let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) };
    if connected == 0 {
        let error = unsafe { GetLastError() };
        if error != ERROR_PIPE_CONNECTED {
            return Err(Failure::with_detail(
                ErrorCode::Internal,
                format!("命名管道连接失败（错误 {error}）"),
            ));
        }
    }
    Ok(())
}

/// 校验调用方：与安装者同一账户，或属于 Administrators（含 UAC 过滤后的 linked token）。
///
/// 账户身份用 `TokenUser` 的 SID 判断：它不受提权过滤影响，也不依赖本地化的组名，
/// 因此在中文 Windows、Microsoft 账户、以及 UAC 关闭/开启的情况下结论一致。
pub fn authorize_client(pipe: HANDLE, installer_sid: &str) -> Result<(), Failure> {
    let mut pid = 0u32;
    let mut token: HANDLE = std::ptr::null_mut();
    unsafe {
        if GetNamedPipeClientProcessId(pipe, &mut pid) == 0 {
            return Err(refusal(format!("无法读取客户端进程（错误 {}）", GetLastError())));
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return Err(refusal(format!("无法打开客户端进程（错误 {}）", GetLastError())));
        }
        let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token);
        CloseHandle(process);
        if opened == 0 {
            return Err(refusal(format!("无法读取客户端凭据（错误 {}）", GetLastError())));
        }
    }

    let owner = unsafe { token_user_sid(token) };
    let same_account = owner.as_deref() == Some(installer_sid);
    let elevated = unsafe { token_is_elevated(token) };
    let admin = unsafe { is_admin_token(token) };
    // 只在必要时才去取 linked token：普通用户没有它，查询会失败。
    let linked_admin = if elevated || admin {
        false
    } else {
        unsafe { linked_token_is_admin(token) }
    };
    unsafe { CloseHandle(token) };

    if same_account || elevated || admin || linked_admin {
        return Ok(());
    }
    Err(refusal(format!(
        "调用账户既不是安装者账户，也不是管理员（提权={elevated} 管理员组={admin} 关联令牌={linked_admin}）"
    )))
}

fn refusal(detail: String) -> Failure {
    Failure::with_detail(ErrorCode::NeedsAdmin, format!("辅助服务拒绝访问：{detail}"))
}

unsafe fn token_is_elevated(token: HANDLE) -> bool {
    let mut info: TOKEN_ELEVATION = std::mem::zeroed();
    let mut size = 0u32;
    if GetTokenInformation(
        token,
        TokenElevation,
        &mut info as *mut TOKEN_ELEVATION as *mut c_void,
        std::mem::size_of::<TOKEN_ELEVATION>() as u32,
        &mut size,
    ) == 0
    {
        return false;
    }
    info.TokenIsElevated != 0
}

unsafe fn is_admin_token(token: HANDLE) -> bool {
    let mut sid = [0u8; 68];
    let mut sid_size = sid.len() as u32;
    if CreateWellKnownSid(
        WinBuiltinAdministratorsSid,
        std::ptr::null_mut(),
        sid.as_mut_ptr() as *mut c_void,
        &mut sid_size,
    ) == 0
    {
        return false;
    }
    let mut member = 0;
    CheckTokenMembership(token, sid.as_mut_ptr() as *mut c_void, &mut member) != 0 && member != 0
}

/// UAC 过滤后的 token 不带 Administrators 组；其 linked token 才带。
unsafe fn linked_token_is_admin(token: HANDLE) -> bool {
    let mut size = 0u32;
    GetTokenInformation(token, TokenLinkedToken, std::ptr::null_mut(), 0, &mut size);
    if size == 0 {
        return false;
    }
    let mut buffer = vec![0u8; size as usize];
    if GetTokenInformation(
        token,
        TokenLinkedToken,
        buffer.as_mut_ptr() as *mut c_void,
        size,
        &mut size,
    ) == 0
    {
        // 1312 = 该 token 没有关联的提权 token（普通用户），按非管理员处理。
        debug_assert_eq!(GetLastError(), ERROR_NO_SUCH_LOGON_SESSION);
        return false;
    }
    let linked = &*(buffer.as_ptr() as *const TOKEN_LINKED_TOKEN);
    let allowed = is_admin_token(linked.LinkedToken);
    CloseHandle(linked.LinkedToken);
    allowed
}
