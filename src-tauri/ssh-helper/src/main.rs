//! helper 进程入口。
//!
//! Windows：以 LocalSystem 服务运行，监听命名管道 `\\.\pipe\shrinkdrop-ssh-helper`，
//! 只接受固定动词。管道 ACL 与调用方鉴权见 `pipe.rs`。
//!
//! 其它平台不构建这个二进制（`cargo build -p shrinkdrop-ssh-helper` 只在 Windows 上有意义），
//! 业务核心可用 `cargo test -p shrinkdrop-ssh-helper` 在任意平台验证。

fn main() {
    #[cfg(windows)]
    {
        if let Err(error) = windows_service::run() {
            eprintln!("shrinkdrop-ssh-helper: {error}");
            std::process::exit(1);
        }
    }
    #[cfg(not(windows))]
    {
        eprintln!("shrinkdrop-ssh-helper 只在 Windows 上运行；业务核心可用 `cargo test -p shrinkdrop-ssh-helper` 验证。");
        std::process::exit(2);
    }
}

#[cfg(windows)]
mod windows_service {
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use std::sync::Arc;

    use shrinkdrop_ssh_helper::config::FsConfigIo;
    use shrinkdrop_ssh_helper::diag;
    use shrinkdrop_ssh_helper::helper::Helper;
    use shrinkdrop_ssh_helper::pipe;
    use shrinkdrop_ssh_helper::runner::SystemRunner;
    use shrinkdrop_ssh_helper::session::{serve as serve_session, SessionEnd};
    use shrinkdrop_ssh_helper::sshd;
    use shrinkdrop_ssh_helper::state::{FsStateIo, STATE_PATH};

    use windows_sys::Win32::System::Services::{
        RegisterServiceCtrlHandlerExW, SERVICE_ACCEPT_STOP, SERVICE_CONTROL_STOP,
        SERVICE_RUNNING, SERVICE_START_PENDING, SERVICE_STATUS, SERVICE_STATUS_HANDLE,
        SERVICE_STOPPED, SERVICE_WIN32_OWN_PROCESS, SetServiceStatus, StartServiceCtrlDispatcherW,
    };

    const SERVICE_NAME: &str = "ShrinkdropSshHelper";
    /// 安装者账户 SID：管道 DACL 只放行它（外加 SYSTEM / Administrators）。
    const INSTALLER_SID_PATH: &str = r"C:\ProgramData\shrinkdrop\installer-sid.txt";

    static mut STATUS_HANDLE: SERVICE_STATUS_HANDLE = std::ptr::null_mut();
    static mut STOPPING: bool = false;

    pub fn run() -> Result<(), String> {
        let args: Vec<String> = std::env::args().collect();
        match args.get(1).map(String::as_str) {
            // 安装/卸载由 app 的提权流程调用，参数固定。
            Some("--install-service") => install_service(),
            Some("--uninstall-service") => uninstall_service(),
            Some("--run-console") => serve(helper()),
            _ => run_service(),
        }
    }

    fn helper() -> Helper {
        let mut helper = Helper::new(
            Arc::new(SystemRunner),
            Arc::new(FsConfigIo),
            Arc::new(FsStateIo),
            sshd::CONFIG_PATH,
            STATE_PATH,
        );
        if let Some(path) = bundled_msi_path() {
            helper = helper.with_bundled_msi(path.display().to_string());
        }
        helper
    }

    /// 随包 MSI 只从安装目录里找：不接受 IPC 传路径，也不从用户可写目录加载。
    fn bundled_msi_path() -> Option<std::path::PathBuf> {
        let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
        let entries = std::fs::read_dir(&dir).ok()?;
        entries.flatten().map(|entry| entry.path()).find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("OpenSSH-Win64-v") && name.ends_with(".msi"))
        })
    }

    fn run_service() -> Result<(), String> {
        let mut name = wide(SERVICE_NAME);
        let table = [
            windows_sys::Win32::System::Services::SERVICE_TABLE_ENTRYW {
                lpServiceName: name.as_mut_ptr(),
                lpServiceProc: Some(service_main),
            },
            windows_sys::Win32::System::Services::SERVICE_TABLE_ENTRYW {
                lpServiceName: std::ptr::null_mut(),
                lpServiceProc: None,
            },
        ];
        let ok = unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) };
        if ok == 0 {
            return Err("无法连接服务控制管理器（请以服务方式启动）".to_string());
        }
        Ok(())
    }

    unsafe extern "system" fn service_main(_argc: u32, _argv: *mut *mut u16) {
        let name = wide(SERVICE_NAME);
        STATUS_HANDLE = RegisterServiceCtrlHandlerExW(
            name.as_ptr(),
            Some(handler),
            std::ptr::null_mut(),
        );
        report(SERVICE_START_PENDING);
        diag::log("service: 启动");
        report(SERVICE_RUNNING);
        if let Err(error) = serve(helper()) {
            diag::log(&format!("service: serve 退出 {error}"));
        }
        diag::log("service: 停止");
        report(SERVICE_STOPPED);
    }

    unsafe extern "system" fn handler(
        control: u32,
        _event: u32,
        _data: *mut std::ffi::c_void,
        _context: *mut std::ffi::c_void,
    ) -> u32 {
        if control == SERVICE_CONTROL_STOP {
            STOPPING = true;
            // 主循环可能正阻塞在 ConnectNamedPipe；自己连一下把 accept 唤醒，
            // 否则 SCM 会一直等（安装升级时表现为“无法停止旧辅助服务”）。
            std::thread::spawn(pipe::poke);
        }
        0
    }

    unsafe fn report(state: u32) {
        let mut status: SERVICE_STATUS = std::mem::zeroed();
        status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
        status.dwCurrentState = state;
        status.dwControlsAccepted = if state == SERVICE_RUNNING {
            SERVICE_ACCEPT_STOP
        } else {
            0
        };
        SetServiceStatus(STATUS_HANDLE, &status);
    }

    /// 管道主循环：每个连接一个线程。
    ///
    /// `lifetime=app` 时 app 会持有一条长连接（`attach`），所以不能串行处理：
    /// 否则持会话期间的状态查询与关闭请求全被堵住。
    fn serve(helper: Helper) -> Result<(), String> {
        use std::io::BufReader;
        use std::sync::Arc;

        let installer_sid = std::fs::read_to_string(INSTALLER_SID_PATH)
            .map(|value| value.trim().to_string())
            .ok()
            .filter(|value| value.starts_with("S-1-"));
        let installer_sid = installer_sid.ok_or("缺少安装者 SID，请重新安装辅助服务")?;
        let helper = Arc::new(helper);

        loop {
            if unsafe { STOPPING } {
                diag::log("serve: 收到停止请求，退出主循环");
                return Ok(());
            }
            let handle = match pipe::create_pipe(&installer_sid) {
                Ok(handle) => handle,
                Err(error) => {
                    // 单个实例创建失败不该杀掉整个服务：记录后稍等重试。
                    diag::log(&format!(
                        "serve: 创建管道失败 {:?} {}",
                        error.code,
                        error.detail.as_deref().unwrap_or_default()
                    ));
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    continue;
                }
            };
            // 客户端可能在 ConnectNamedPipe 之前就断开（例如 app 只是在探测管道是否存在），
            // 这种错误只关掉这一个实例。之前的 `?` 会让整个服务退出，表现就是
            // “面板说连不上、具体原因 helper 连接中断”。
            if let Err(error) = pipe::accept(handle) {
                diag::log(&format!(
                    "serve: 接受连接失败 {:?} {}",
                    error.code,
                    error.detail.as_deref().unwrap_or_default()
                ));
                unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
                continue;
            }
            // 服务正在停止：这次 accept 多半是我们自己的 poke 唤醒（或最后一个客户端），
            // 直接关掉并退出，绝不进入“读一帧”那一步 —— 否则会永久阻塞在 ReadFile 上，
            // SCM 永远等不到 STOPPED，安装器也就覆盖不了 helper 的 exe。
            if unsafe { STOPPING } {
                unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
                diag::log("serve: 停止中，关闭最后一条连接");
                continue;
            }
            let helper = helper.clone();
            let sid = installer_sid.clone();
            // HANDLE 是裸指针，不能跨线程；转成 usize 再在闭包里还原。
            let raw = handle as usize;
            // 鉴权与应答都放到线程里：未授权客户端如果连上却不发数据，
            // 主循环不能被它卡住（那等于任何本机进程都能让服务失去响应）。
            std::thread::spawn(move || {
                let handle = raw as *mut std::ffi::c_void;
                let file = unsafe { std::fs::File::from_raw_handle(handle as RawHandle) };
                let reader_file = match file.try_clone() {
                    Ok(clone) => clone,
                    Err(error) => {
                        diag::log(&format!("serve: 管道复制失败 {error}"));
                        return;
                    }
                };
                if let Err(error) = pipe::authorize_client(handle, &sid) {
                    diag::log(&format!(
                        "serve: 拒绝连接 {}",
                        error.detail.as_deref().unwrap_or_default()
                    ));
                    let mut reader = BufReader::new(reader_file);
                    let mut writer = file;
                    let _ = refuse_session(&mut reader, &mut writer, &error);
                    return;
                }
                let mut reader = BufReader::new(reader_file);
                let mut writer = file;
                if serve_session(&helper, &mut reader, &mut writer) == SessionEnd::Shutdown {
                    unsafe { STOPPING = true };
                }
            });
        }
    }

    /// 未授权的连接：回一条错误帧后关闭，绝不执行任何动作。
    fn refuse_session(
        reader: &mut impl std::io::BufRead,
        writer: &mut impl std::io::Write,
        error: &shrinkdrop_ssh_helper::helper::Failure,
    ) -> std::io::Result<()> {
        use shrinkdrop_ssh_core::{read_request, write_frame, Response};
        if let Ok(request) = read_request(reader) {
            let _ = write_frame(writer, &Response::error(request.id, error.to_helper_error()));
        }
        Ok(())
    }

    fn install_service() -> Result<(), String> {
        use windows_sys::Win32::System::Services::{
            CreateServiceW, OpenSCManagerW, OpenServiceW, StartServiceW,
            SC_MANAGER_CREATE_SERVICE, SERVICE_AUTO_START, SERVICE_ERROR_NORMAL,
            SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_START, SERVICE_STOP,
            SERVICE_WIN32_OWN_PROCESS,
        };

        // 先记安装者 SID：服务启动时要靠它构造管道 DACL。
        let sid = pipe::install_sid()
            .map_err(|error| format!("{:?} {}", error.code, error.detail.unwrap_or_default()))?;
        if let Some(parent) = std::path::Path::new(INSTALLER_SID_PATH).parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(INSTALLER_SID_PATH, &sid).map_err(|error| error.to_string())?;

        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        let exe_wide = wide(&service_binary_path(&exe));
        let name_wide = wide(SERVICE_NAME);
        let display = wide("shrinkdrop SSH Helper");
        // 句柄必须带 SERVICE_START，否则后面 StartServiceW 会被拒绝（0 只是“可创建”）；
        // 升级场景还要 SERVICE_STOP，才能停掉跑着旧二进制的进程。
        let access = SERVICE_START | SERVICE_QUERY_STATUS | SERVICE_STOP;
        unsafe {
            let manager =
                OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CREATE_SERVICE);
            if manager.is_null() {
                return Err(format!(
                    "需要管理员权限安装辅助服务（错误 {}）",
                    last_error()
                ));
            }
            let created = CreateServiceW(
                manager,
                name_wide.as_ptr(),
                display.as_ptr(),
                access,
                SERVICE_WIN32_OWN_PROCESS,
                SERVICE_AUTO_START,
                SERVICE_ERROR_NORMAL,
                exe_wide.as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
            );
            let service = if created.is_null() {
                // 1073 = 服务已存在：按幂等处理，但要拿一个能启动它的句柄。
                if last_error() != 1073 {
                    return Err(format!("创建服务失败（错误 {}）", last_error()));
                }
                let existing = OpenServiceW(manager, name_wide.as_ptr(), access);
                if existing.is_null() {
                    return Err(format!(
                        "服务已存在但无法打开（错误 {}），请以管理员身份重试",
                        last_error()
                    ));
                }
                existing
            } else {
                created
            };

            // 已存在的服务可能正在跑旧版本二进制（app 升级后磁盘上是新的、内存里是旧的）：
            // 先停再起，保证加载的是当前文件。
            if !created.is_null() {
                // 新建的服务本来就没在跑，不用停。
            } else if stop_and_wait(service) {
                // 停止成功（或已停止），继续启动。
            } else {
                // 老版本 helper（<=0.1.9）会卡在管道读里，SCM 停不下来。
                // 它锁着 exe，必须结束进程，否则新二进制既装不上也起不来。
                diag::log("install: 旧服务停不下来，强制结束进程");
                if let Some(pid) = query_pid(service) {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/f", "/pid", &pid.to_string()])
                        .output();
                }
                for _ in 0..30 {
                    if query_state(service) != Some(SERVICE_RUNNING) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }

            if StartServiceW(service, 0, std::ptr::null()) == 0 {
                let code = last_error();
                // 1056 = 已在运行，按幂等处理。
                if code != 1056 {
                    return Err(format!("启动辅助服务失败（错误 {code}）"));
                }
            }

            // 等服务真正进入 RUNNING：SCM 返回成功不等于进程已经起来。
            for _ in 0..50 {
                if query_state(service) == Some(SERVICE_RUNNING) {
                    return Ok(());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err("辅助服务已安装但未进入运行状态；请在「服务」中查看 ShrinkdropSshHelper".to_string())
        }
    }

    /// 停掉正在运行的服务并等到 STOPPED；已经是停止状态也算成功。
    unsafe fn stop_and_wait(service: windows_sys::Win32::System::Services::SC_HANDLE) -> bool {
        use windows_sys::Win32::System::Services::{
            ControlService, SERVICE_CONTROL_STOP, SERVICE_STOPPED, SERVICE_STATUS,
        };
        let mut status: SERVICE_STATUS = std::mem::zeroed();
        if ControlService(service, SERVICE_CONTROL_STOP, &mut status) == 0 {
            // 1062 = 服务未启动，直接当作已停止。
            return last_error() == 1062 || query_state(service) == Some(SERVICE_STOPPED);
        }
        for _ in 0..50 {
            if query_state(service) == Some(SERVICE_STOPPED) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        false
    }

    /// 服务二进制路径：含空格时必须加引号，否则 SCM 会把参数拆开。
    fn service_binary_path(exe: &std::path::Path) -> String {
        let path = exe.display().to_string();
        if path.contains(' ') {
            format!("\"{path}\"")
        } else {
            path
        }
    }

    unsafe fn query_pid(
        service: windows_sys::Win32::System::Services::SC_HANDLE,
    ) -> Option<u32> {
        use windows_sys::Win32::System::Services::{
            QueryServiceStatusEx, SC_STATUS_PROCESS_INFO, SERVICE_STATUS_PROCESS,
        };
        let mut status: SERVICE_STATUS_PROCESS = std::mem::zeroed();
        let mut needed = 0u32;
        let ok = QueryServiceStatusEx(
            service,
            SC_STATUS_PROCESS_INFO,
            &mut status as *mut SERVICE_STATUS_PROCESS as *mut u8,
            std::mem::size_of::<SERVICE_STATUS_PROCESS>() as u32,
            &mut needed,
        );
        (ok != 0 && status.dwProcessId != 0).then_some(status.dwProcessId)
    }

    unsafe fn query_state(
        service: windows_sys::Win32::System::Services::SC_HANDLE,
    ) -> Option<u32> {
        use windows_sys::Win32::System::Services::{
            QueryServiceStatusEx, SC_STATUS_PROCESS_INFO, SERVICE_STATUS_PROCESS,
        };
        let mut status: SERVICE_STATUS_PROCESS = std::mem::zeroed();
        let mut needed = 0u32;
        let ok = QueryServiceStatusEx(
            service,
            SC_STATUS_PROCESS_INFO,
            &mut status as *mut SERVICE_STATUS_PROCESS as *mut u8,
            std::mem::size_of::<SERVICE_STATUS_PROCESS>() as u32,
            &mut needed,
        );
        (ok != 0).then_some(status.dwCurrentState)
    }

    fn uninstall_service() -> Result<(), String> {
        use windows_sys::Win32::System::Services::{
            ControlService, DeleteService, OpenSCManagerW, OpenServiceW, SC_MANAGER_CONNECT,
            SERVICE_STOP,
        };
        // DeleteService 需要 DELETE 标准权限，只有 SERVICE_STOP 会被拒。
        const DELETE: u32 = 0x0001_0000;
        let name_wide = wide(SERVICE_NAME);
        unsafe {
            let manager = OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT);
            if manager.is_null() {
                return Err(format!("需要管理员权限（错误 {}）", last_error()));
            }
            let service = OpenServiceW(manager, name_wide.as_ptr(), SERVICE_STOP | DELETE);
            if service.is_null() {
                return Ok(());
            }
            let _ = ControlService(service, SERVICE_CONTROL_STOP, std::ptr::null_mut());
            if DeleteService(service) == 0 {
                return Err(format!("删除服务失败（错误 {}）", last_error()));
            }
        }
        let _ = std::fs::remove_file(INSTALLER_SID_PATH);
        Ok(())
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn last_error() -> u32 {
        unsafe { windows_sys::Win32::Foundation::GetLastError() }
    }
}
