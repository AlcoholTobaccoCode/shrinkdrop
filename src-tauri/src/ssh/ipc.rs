//! 与 helper 的 IPC 客户端（传输层无关）。
//!
//! 生产环境里传输层是 Windows 命名管道；测试里可以是内存流，因此握手、版本校验、
//! 错误映射都能在任意平台验证。helper 侧协议循环见 `ssh-helper/src/session.rs`。

use std::io::{BufRead, Write};

use shrinkdrop_ssh_core::{
    read_frame, write_frame, ErrorCode, FrameError, HelperStatus, Payload, Request,
    Response, Verb, PROTOCOL,
};

use super::{HelperInfo, SshError};

/// 一个已经完成握手的 helper 会话。
pub struct Session {
    reader: Box<dyn BufRead + Send>,
    writer: Box<dyn Write + Send>,
    next_id: u64,
    helper_version: String,
    protocol: u32,
}

impl Session {
    /// 握手：发送 `hello`，校验协议版本。
    pub fn open(
        mut reader: Box<dyn BufRead + Send>,
        mut writer: Box<dyn Write + Send>,
        app_version: &str,
    ) -> Result<Self, SshError> {
        let request = Request::hello(1, app_version);
        write_frame(&mut writer, &request).map_err(|_| {
            SshError::with_detail(ErrorCode::HelperUnavailable, "写入 helper 失败")
        })?;
        let response: Response = read_frame(&mut reader).map_err(map_read_error)?;
        match response.payload {
            Payload::Hello(hello) => {
                if hello.protocol != PROTOCOL {
                    return Err(SshError::with_detail(
                        ErrorCode::HelperVersionMismatch,
                        format!("helper 协议 {}，app 需要 {}", hello.protocol, PROTOCOL),
                    ));
                }
                Ok(Self {
                    reader,
                    writer,
                    next_id: 2,
                    helper_version: hello.helper_version,
                    protocol: hello.protocol,
                })
            }
            Payload::Error(error) => Err(error.into()),
            _ => Err(SshError::new(ErrorCode::HelperVersionMismatch)),
        }
    }

    pub fn helper_version(&self) -> &str {
        &self.helper_version
    }

    pub fn protocol(&self) -> u32 {
        self.protocol
    }

    fn request(&mut self, verb: Verb, lifetime: Option<shrinkdrop_ssh_core::SshLifetime>, port: Option<u16>) -> Result<Payload, SshError> {
        let mut request = Request::new(self.next_id, verb);
        self.next_id += 1;
        request.lifetime = lifetime;
        request.port = port;
        write_frame(&mut self.writer, &request).map_err(|_| {
            SshError::with_detail(ErrorCode::HelperUnavailable, "写入 helper 失败")
        })?;
        let response: Response = read_frame(&mut self.reader).map_err(map_read_error)?;
        match response.payload {
            Payload::Error(error) => Err(error.into()),
            payload => Ok(payload),
        }
    }

    pub fn status(&mut self) -> Result<HelperStatus, SshError> {
        expect_status(self.request(Verb::Status, None, None)?)
    }

    pub fn enable(
        &mut self,
        lifetime: shrinkdrop_ssh_core::SshLifetime,
        port: u16,
    ) -> Result<HelperStatus, SshError> {
        expect_status(self.request(Verb::Enable, Some(lifetime), Some(port))?)
    }

    pub fn disable(&mut self) -> Result<HelperStatus, SshError> {
        expect_status(self.request(Verb::Disable, None, None)?)
    }

    pub fn set_lifetime(
        &mut self,
        lifetime: shrinkdrop_ssh_core::SshLifetime,
    ) -> Result<HelperStatus, SshError> {
        expect_status(self.request(Verb::SetLifetime, Some(lifetime), None)?)
    }

    pub fn set_port(&mut self, port: u16) -> Result<HelperStatus, SshError> {
        expect_status(self.request(Verb::SetPort, None, Some(port))?)
    }

    /// FoD 失败后的兜底：让 helper 安装随包 OpenSSH。
    pub fn install_bundled(&mut self) -> Result<HelperStatus, SshError> {
        expect_status(self.request(Verb::InstallBundled, None, None)?)
    }

    pub fn attach(&mut self) -> Result<(), SshError> {
        self.expect_ack(Verb::Attach)
    }

    pub fn detach(&mut self) -> Result<(), SshError> {
        self.expect_ack(Verb::Detach)
    }

    pub fn shutdown(&mut self) -> Result<(), SshError> {
        self.expect_ack(Verb::ShutdownHelper)
    }

    fn expect_ack(&mut self, verb: Verb) -> Result<(), SshError> {
        match self.request(verb, None, None)? {
            Payload::Ack => Ok(()),
            Payload::Error(error) => Err(error.into()),
            _ => Err(SshError::new(ErrorCode::Internal)),
        }
    }
}

fn expect_status(payload: Payload) -> Result<HelperStatus, SshError> {
    match payload {
        Payload::Status(status) => Ok(status),
        Payload::Error(error) => Err(error.into()),
        _ => Err(SshError::new(ErrorCode::Internal)),
    }
}

fn map_read_error(error: FrameError) -> SshError {
    match error {
        FrameError::TooLarge => SshError::with_detail(ErrorCode::FrameTooLarge, "helper 回帧过大"),
        FrameError::Invalid => SshError::with_detail(ErrorCode::Internal, "helper 回帧非法"),
        FrameError::Closed | FrameError::Io => {
            SshError::with_detail(ErrorCode::HelperUnavailable, "helper 连接中断")
        }
    }
}

/// 轮询直到条件成立或超时；返回是否成立。提权安装不等待子进程，必须靠这个确认就绪。
pub fn wait_until_ready(mut ready: impl FnMut() -> bool, timeout: std::time::Duration) -> Option<()> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if ready() {
            return Some(());
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(POLL);
    }
}

const POLL: std::time::Duration = std::time::Duration::from_millis(50);

/// 打开一次会话的传输层；生产实现是 Windows 命名管道。
pub trait Transport: Send + Sync {
    fn open(&self) -> Result<Session, SshError>;
    /// helper 是否已安装（服务/管道存在）。
    fn installed(&self) -> bool;
    /// 安装/卸载 helper 需要提权，实现者负责弹授权。
    fn install(&self) -> Result<(), SshError>;
    fn uninstall(&self) -> Result<(), SshError>;
}

/// 基于任意 `Transport` 的后端：每次短操作开一个会话，`attach` 保持长会话。
pub struct TransportBackend {
    transport: Box<dyn Transport>,
    long_lived: std::sync::Mutex<Option<Session>>,
}

impl TransportBackend {
    pub fn new(transport: Box<dyn Transport>) -> Self {
        Self {
            transport,
            long_lived: std::sync::Mutex::new(None),
        }
    }

    fn with_session<T>(
        &self,
        f: impl FnOnce(&mut Session) -> Result<T, SshError>,
    ) -> Result<T, SshError> {
        let mut session = self.transport.open()?;
        f(&mut session)
    }
}

impl super::SshBackend for TransportBackend {
    fn helper_info(&self) -> HelperInfo {
        // `writable` 表示“这个构建有没有可写的控制面”，与 helper 此刻是否在跑无关。
        // 之前把“连不上”当成只读，Windows 上会错误地显示成 macOS 的手动开启引导。
        let mut info = HelperInfo {
            available: true,
            writable: true,
            installed: self.transport.installed(),
            approved: false,
            version: None,
        };
        if let Ok(session) = self.transport.open() {
            info.installed = true;
            info.approved = true;
            info.version = Some(session.helper_version().to_string());
        }
        info
    }

    fn status(&self) -> Result<HelperStatus, SshError> {
        self.with_session(|session| session.status())
    }

    fn enable(
        &self,
        lifetime: shrinkdrop_ssh_core::SshLifetime,
        port: u16,
    ) -> Result<HelperStatus, SshError> {
        self.with_session(|session| session.enable(lifetime, port))
    }

    fn disable(&self) -> Result<HelperStatus, SshError> {
        self.with_session(|session| session.disable())
    }

    fn set_lifetime(
        &self,
        lifetime: shrinkdrop_ssh_core::SshLifetime,
    ) -> Result<HelperStatus, SshError> {
        self.with_session(|session| session.set_lifetime(lifetime))
    }

    fn set_port(&self, port: u16) -> Result<HelperStatus, SshError> {
        self.with_session(|session| session.set_port(port))
    }

    fn attach(&self) -> Result<(), SshError> {
        let mut slot = self
            .long_lived
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_some() {
            return Ok(());
        }
        let mut session = self.transport.open()?;
        session.attach()?;
        *slot = Some(session);
        Ok(())
    }

    fn detach(&self) -> Result<(), SshError> {
        let mut slot = self
            .long_lived
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(mut session) = slot.take() else {
            return Ok(());
        };
        // 关闭连接本身也会让 helper 减少引用计数；detach 让状态机先决定是否关 sshd。
        session.detach()
    }

    fn install_bundled(&self) -> Result<HelperStatus, SshError> {
        self.with_session(|session| session.install_bundled())
    }

    fn install_helper(&self) -> Result<(), SshError> {
        self.transport.install()
    }

    fn uninstall_helper(&self) -> Result<(), SshError> {
        if let Ok(mut session) = self.transport.open() {
            let _ = session.shutdown();
        }
        self.transport.uninstall()
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::io::BufReader;
    use std::os::unix::net::UnixStream;
    use std::sync::Arc;

    use shrinkdrop_ssh_core::{ErrorCode, SshLifetime};
    use shrinkdrop_ssh_helper::helper::Helper;
    use shrinkdrop_ssh_helper::session::{serve, SessionEnd};
    use shrinkdrop_ssh_helper::testing::Fake;

    use super::*;
    use crate::ssh::SshBackend;

    /// 把 helper 的业务核心接到 socket 对上：验证的是真实协议循环，不是桩。
    struct LocalTransport {
        helper: Arc<Helper>,
    }

    impl Transport for LocalTransport {
        fn open(&self) -> Result<Session, SshError> {
            let (client, server) = UnixStream::pair().unwrap();
            let helper = self.helper.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(server.try_clone().unwrap());
                let mut writer = server;
                let _ = serve(&helper, &mut reader, &mut writer);
            });
            Session::open(
                Box::new(BufReader::new(client.try_clone().unwrap())),
                Box::new(client),
                "test",
            )
        }

        fn installed(&self) -> bool {
            true
        }

        fn install(&self) -> Result<(), SshError> {
            Ok(())
        }

        fn uninstall(&self) -> Result<(), SshError> {
            Ok(())
        }
    }

    fn backend() -> (Arc<Fake>, TransportBackend) {
        let fake = Arc::new(Fake::new());
        let helper = Arc::new(Helper::new(
            fake.clone(),
            fake.clone(),
            fake.clone(),
            "config",
            "state.json",
        ));
        (fake, TransportBackend::new(Box::new(LocalTransport { helper })))
    }

    #[test]
    fn enable_status_disable_over_real_protocol() {
        let (fake, backend) = backend();
        let status = backend.enable(SshLifetime::Persistent, 2222).unwrap();
        assert!(status.enabled);
        assert_eq!(status.port, 2222);
        assert!(fake.lock().config.contains("Port 2222"));

        let status = backend.status().unwrap();
        assert!(status.listening);
        assert_eq!(status.port, 2222);

        let status = backend.disable().unwrap();
        assert!(!status.os_enabled);
        assert!(!status.owned);
        assert_eq!(fake.lock().config, "Port 22\nPasswordAuthentication yes\n");
    }

    #[test]
    fn port_in_use_error_survives_the_wire() {
        let (fake, backend) = backend();
        fake.occupy(2222, 999, "nginx.exe");
        let error = backend.enable(SshLifetime::Persistent, 2222).unwrap_err();
        assert_eq!(error.code, ErrorCode::PortInUse);
        assert!(error.detail.unwrap_or_default().contains("nginx.exe"));
    }

    #[test]
    fn attach_detach_keeps_app_lifetime_refcount() {
        let (_, backend) = backend();
        backend.enable(SshLifetime::App, 22).unwrap();
        backend.attach().unwrap();
        assert!(backend.status().unwrap().os_enabled);
        backend.detach().unwrap();
        assert!(!backend.status().unwrap().os_enabled, "最后会话退出后应关闭");
    }

    #[test]
    fn persistent_survives_detach_over_the_wire() {
        let (_, backend) = backend();
        backend.enable(SshLifetime::Persistent, 22).unwrap();
        backend.attach().unwrap();
        backend.detach().unwrap();
        assert!(backend.status().unwrap().os_enabled);
    }

    #[test]
    fn uninstall_helper_does_not_remove_system_openssh() {
        let (fake, backend) = backend();
        backend.enable(SshLifetime::App, 22).unwrap();
        backend.uninstall_helper().unwrap();
        assert_eq!(fake.lock().config, "Port 22\nPasswordAuthentication yes\n");
        // 服务仍在，只是不再由 app 拥有。
        assert!(matches!(
            fake.lock().svc,
            Some(shrinkdrop_ssh_helper::testing::Svc::Stopped { .. })
        ));
    }

    #[test]
    fn session_end_shutdown_is_acknowledged() {
        let (_, backend) = backend();
        backend.uninstall_helper().unwrap();
        assert!(backend.status().is_ok());
    }

    #[test]
    fn helper_info_reports_version_after_handshake() {
        let (_, backend) = backend();
        let info = backend.helper_info();
        assert!(info.available);
        assert!(info.writable);
        assert!(info.version.is_some());
    }

    #[test]
    fn wait_until_ready_stops_on_timeout_and_on_success() {
        use std::cell::Cell;
        use std::time::{Duration, Instant};

        let attempts = Cell::new(0);
        assert_eq!(
            wait_until_ready(
                || {
                    attempts.set(attempts.get() + 1);
                    true
                },
                Duration::from_millis(100)
            ),
            Some(())
        );
        assert_eq!(attempts.get(), 1, "第一次就绪时不该继续轮询");

        let start = Instant::now();
        let never = wait_until_ready(|| false, Duration::from_millis(120));
        assert_eq!(never, None);
        assert!(start.elapsed() >= Duration::from_millis(120));
    }

    #[test]
    fn unknown_helper_socket_yields_helper_unavailable() {
        struct Missing;
        impl Transport for Missing {
            fn open(&self) -> Result<Session, SshError> {
                Err(SshError::new(ErrorCode::HelperUnavailable))
            }
            fn installed(&self) -> bool {
                false
            }
            fn install(&self) -> Result<(), SshError> {
                Ok(())
            }
            fn uninstall(&self) -> Result<(), SshError> {
                Ok(())
            }
        }
        let backend = TransportBackend::new(Box::new(Missing));
        assert_eq!(
            backend.status().unwrap_err().code,
            ErrorCode::HelperUnavailable
        );
        let info = backend.helper_info();
        assert!(info.available, "构建含后端，但 helper 未运行");
        assert!(
            info.writable,
            "writable 表示构建能力，不是 helper 是否在跑——否则 Windows 会退化成只读 UI"
        );
        assert!(!info.installed);
        assert!(!info.approved);
    }

    #[test]
    fn session_loop_reports_protocol_mismatch() {
        // 直接构造一个协议版本不一致的客户端，确认 app 侧会拒绝。
        let (client, server) = UnixStream::pair().unwrap();
        let fake = Arc::new(Fake::new());
        let helper = Arc::new(Helper::new(
            fake.clone(),
            fake.clone(),
            fake.clone(),
            "config",
            "state.json",
        ));
        std::thread::spawn(move || {
            let mut reader = BufReader::new(server.try_clone().unwrap());
            let mut writer = server;
            let _ = serve(&helper, &mut reader, &mut writer);
        });
        let mut client = client;
        let mut request = shrinkdrop_ssh_core::Request::hello(1, "app");
        request.protocol = Some(shrinkdrop_ssh_core::PROTOCOL + 1);
        shrinkdrop_ssh_core::write_frame(&mut client, &request).unwrap();
        let mut reader = BufReader::new(client);
        let response: shrinkdrop_ssh_core::Response =
            shrinkdrop_ssh_core::read_frame(&mut reader).unwrap();
        match response.payload {
            shrinkdrop_ssh_core::Payload::Error(error) => {
                assert_eq!(error.code, ErrorCode::HelperVersionMismatch)
            }
            other => panic!("expected error, got {other:?}"),
        }
    }

    #[test]
    fn serve_returns_shutdown_end_on_shutdown_verb() {
        let fake = Arc::new(Fake::new());
        let helper = Helper::new(fake.clone(), fake.clone(), fake.clone(), "config", "state.json");
        let (client, server) = UnixStream::pair().unwrap();
        let handle = std::thread::spawn(move || {
            let mut reader = BufReader::new(server.try_clone().unwrap());
            let mut writer = server;
            serve(&helper, &mut reader, &mut writer)
        });
        let mut client = client;
        shrinkdrop_ssh_core::write_frame(&mut client, &shrinkdrop_ssh_core::Request::hello(1, "app"))
            .unwrap();
        let _: shrinkdrop_ssh_core::Response =
            shrinkdrop_ssh_core::read_frame(&mut BufReader::new(client.try_clone().unwrap())).unwrap();
        shrinkdrop_ssh_core::write_frame(
            &mut client,
            &shrinkdrop_ssh_core::Request::new(2, shrinkdrop_ssh_core::Verb::ShutdownHelper),
        )
        .unwrap();
        let end = handle.join().unwrap();
        assert_eq!(end, SessionEnd::Shutdown);
    }
}
