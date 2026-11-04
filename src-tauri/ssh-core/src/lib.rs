//! app 与特权 helper 之间的协议，以及双方共享的状态类型。
//!
//! 约定见 `docs/ssh/helper-protocol.md`：换行分隔的 JSON 帧，单帧上限 64 KiB，
//! 只接受固定动词，helper 不提供任意命令执行。

use std::io::{self, BufRead, Write};

use serde::{Deserialize, Serialize};

/// 协议版本；app 与 helper 必须一致，否则返回 `helper_version_mismatch`。
pub const PROTOCOL: u32 = 1;
/// 单帧上限（含换行）：超限视为协议错误并断开连接。
pub const MAX_FRAME: usize = 64 * 1024;
/// 状态文件自身格式版本，独立于协议版本，避免协议升级误改磁盘格式。
pub const STATE_VERSION: u32 = 1;

/// SSH 的生命周期模式。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshLifetime {
    /// 仅应用运行时开启：最后一个客户端 detach 后由 helper 关闭自己的实例。
    #[default]
    App,
    /// 后台常驻：应用退出后仍保持开启。
    Persistent,
}

/// helper 接受的固定动词。没有自由文本命令、没有路径参数。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verb {
    Hello,
    Status,
    Enable,
    Disable,
    SetLifetime,
    SetPort,
    Attach,
    Detach,
    ShutdownHelper,
    /// FoD 失败后的兜底：安装随包固定版 OpenSSH（需调用方在 UI 里已确认）。
    InstallBundled,
}

/// 请求帧。`lifetime`/`port` 只有对应动词才读取，其余情况忽略。
///
/// 拒绝未知字段：协议不接受任何自由形状的载荷（例如 `command`/`path`），
/// 带多余字段的帧一律视为非法输入，避免 helper 实现者误以为多出来的字段无害。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: u64,
    pub verb: Verb,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifetime: Option<SshLifetime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

impl Request {
    pub fn new(id: u64, verb: Verb) -> Self {
        Self {
            id,
            verb,
            protocol: None,
            app_version: None,
            lifetime: None,
            port: None,
        }
    }

    pub fn with_lifetime(mut self, lifetime: SshLifetime) -> Self {
        self.lifetime = Some(lifetime);
        self
    }

    pub fn with_port(mut self, port: u16) -> Self {
        self.port = Some(port);
        self
    }

    pub fn hello(id: u64, app_version: impl Into<String>) -> Self {
        Self {
            protocol: Some(PROTOCOL),
            app_version: Some(app_version.into()),
            ..Self::new(id, Verb::Hello)
        }
    }
}

/// 协议错误码，同时也是 UI 的文案键。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    UnsupportedOs,
    UnsupportedCustomPort,
    NeedsAdmin,
    HelperUnavailable,
    HelperVersionMismatch,
    FeatureMissing,
    ServiceMissing,
    ServiceStartFailed,
    ServiceStopFailed,
    FirewallBlocked,
    PolicyBlocked,
    PortInUse,
    Busy,
    /// 只读模式：本构建没有可用的特权控制面（未签名路线的 macOS）。
    ReadOnly,
    Internal,
    UnsupportedVerb,
    FrameTooLarge,
    Timeout,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelperError {
    pub code: ErrorCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl HelperError {
    pub fn new(code: ErrorCode) -> Self {
        Self { code, detail: None }
    }

    pub fn with_detail(code: ErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: Some(detail.into()),
        }
    }
}

/// sshd 的安装来源，UI 需要区分“系统自带”和“应用随包安装”。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallSource {
    /// 系统预设（macOS 内置 sshd / 已存在的 sshd 服务）。
    #[default]
    System,
    /// Windows 可选功能（Feature on Demand）。
    Fod,
    /// 应用随包安装的固定版本。
    Bundled,
}

/// 目标端口被谁占用。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortOwner {
    pub port: u16,
    pub pid: u32,
    pub process: String,
}

/// 系统 SSH 的三态：`unknown` 表示“没权限”或“端口被别的进程占用”，
/// 不能当作“已开启”展示。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OsState {
    Enabled,
    #[default]
    Disabled,
    Unknown,
}

impl OsState {
    pub fn as_str(self) -> &'static str {
        match self {
            OsState::Enabled => "enabled",
            OsState::Disabled => "disabled",
            OsState::Unknown => "unknown",
        }
    }
}

/// helper 的状态快照。`os_enabled` 是系统实际状态，`enabled` 是 helper 期望状态。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelperStatus {
    pub enabled: bool,
    pub os_enabled: bool,
    /// 三态结论；缺省时由 `os_enabled` 推导。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_state: Option<OsState>,
    pub listening: bool,
    pub port: u16,
    pub owned: bool,
    pub lifetime: SshLifetime,
    pub install_source: InstallSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundled_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_in_use: Option<PortOwner>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

impl Default for HelperStatus {
    fn default() -> Self {
        Self {
            enabled: false,
            os_enabled: false,
            os_state: None,
            listening: false,
            port: 22,
            owned: false,
            lifetime: SshLifetime::App,
            install_source: InstallSource::System,
            bundled_version: None,
            port_in_use: None,
            fingerprint: None,
        }
    }
}

/// 握手响应。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub helper_version: String,
    pub protocol: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Payload {
    Hello(Hello),
    Status(HelperStatus),
    Ack,
    Error(HelperError),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Response {
    pub id: u64,
    pub payload: Payload,
}

impl Response {
    pub fn status(id: u64, status: HelperStatus) -> Self {
        Self {
            id,
            payload: Payload::Status(status),
        }
    }

    pub fn ack(id: u64) -> Self {
        Self { id, payload: Payload::Ack }
    }

    pub fn error(id: u64, error: HelperError) -> Self {
        Self {
            id,
            payload: Payload::Error(error),
        }
    }
}

/// helper 的持久化状态文件，root/SYSTEM 所有，原子写。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", default)]
pub struct StateFile {
    pub version: u32,
    pub desired: bool,
    pub lifetime: SshLifetime,
    pub port: u16,
    pub owned: bool,
    pub installed_by_app: bool,
    pub enabled_at: Option<u64>,
    pub previous_start_type: Option<String>,
    pub previous_config_path: Option<String>,
    pub last_error: Option<ErrorCode>,
}

impl Default for StateFile {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            desired: false,
            lifetime: SshLifetime::App,
            port: 22,
            owned: false,
            installed_by_app: false,
            enabled_at: None,
            previous_start_type: None,
            previous_config_path: None,
            last_error: None,
        }
    }
}

/// 帧读取失败的原因：区分“对端关闭”“超限”“不是合法 JSON”。
#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    Closed,
    TooLarge,
    Invalid,
    Io,
}

impl FrameError {
    fn from_io(error: &io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset => FrameError::Closed,
            _ => FrameError::Io,
        }
    }
}

pub fn write_frame<W: Write, T: Serialize>(writer: &mut W, value: &T) -> io::Result<()> {
    let mut body = serde_json::to_vec(value)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "serialize"))?;
    if body.len() + 1 > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "frame too large"));
    }
    body.push(b'\n');
    writer.write_all(&body)?;
    writer.flush()
}

/// 读一帧请求；动词非法时仍能取回 `id`，helper 可以据此回 `unsupported_verb`。
#[derive(Debug, PartialEq, Eq)]
pub enum RequestError {
    Frame(FrameError),
    UnsupportedVerb(u64),
}

pub fn read_request<R: BufRead>(reader: &mut R) -> Result<Request, RequestError> {
    let raw: serde_json::Value =
        read_frame(reader).map_err(|error| RequestError::Frame(error))?;
    match serde_json::from_value::<Request>(raw.clone()) {
        Ok(request) => Ok(request),
        Err(_) => match raw.get("id").and_then(|value| value.as_u64()) {
            Some(id) => Err(RequestError::UnsupportedVerb(id)),
            None => Err(RequestError::Frame(FrameError::Invalid)),
        },
    }
}

pub fn read_frame<R: BufRead, T: for<'de> Deserialize<'de>>(reader: &mut R) -> Result<T, FrameError> {
    let mut buffer = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|error| FrameError::from_io(&error))?;
        if available.is_empty() {
            return Err(FrameError::Closed);
        }
        match available.iter().position(|byte| *byte == b'\n') {
            Some(index) => {
                buffer.extend_from_slice(&available[..index]);
                reader.consume(index + 1);
                if buffer.len() + 1 > MAX_FRAME {
                    return Err(FrameError::TooLarge);
                }
                break;
            }
            None => {
                if buffer.len() + available.len() + 1 > MAX_FRAME {
                    return Err(FrameError::TooLarge);
                }
                buffer.extend_from_slice(available);
                let len = available.len();
                reader.consume(len);
            }
        }
    }
    if buffer.is_empty() {
        return Err(FrameError::Invalid);
    }
    serde_json::from_slice(&buffer).map_err(|_| FrameError::Invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn lifetime_wire_names_are_stable() {
        assert_eq!(serde_json::to_string(&SshLifetime::App).unwrap(), "\"app\"");
        assert_eq!(
            serde_json::to_string(&SshLifetime::Persistent).unwrap(),
            "\"persistent\""
        );
    }

    #[test]
    fn request_roundtrip_keeps_optional_fields_sparse() {
        let request = Request::new(7, Verb::Status);
        let json = serde_json::to_string(&request).unwrap();
        assert_eq!(json, "{\"id\":7,\"verb\":\"status\"}");

        let mut cursor = Cursor::new(frame_bytes(&request));
        let decoded: Request = read_frame(&mut cursor).unwrap();
        assert_eq!(decoded, request);
    }

    #[test]
    fn enable_request_carries_lifetime_and_port() {
        let request = Request::new(3, Verb::Enable)
            .with_lifetime(SshLifetime::Persistent)
            .with_port(2222);
        let decoded: Request = serde_json::from_slice(&serde_json::to_vec(&request).unwrap()).unwrap();
        assert_eq!(decoded.lifetime, Some(SshLifetime::Persistent));
        assert_eq!(decoded.port, Some(2222));
    }

    #[test]
    fn hello_requires_protocol_field() {
        let request = Request::hello(1, "0.1.6");
        let decoded: Request = serde_json::from_slice(&serde_json::to_vec(&request).unwrap()).unwrap();
        assert_eq!(decoded.verb, Verb::Hello);
        assert_eq!(decoded.protocol, Some(PROTOCOL));
    }

    #[test]
    fn unknown_verb_keeps_the_request_id_for_a_reply() {
        let mut cursor = Cursor::new(b"{\"id\":42,\"verb\":\"run_shell\"}\n".to_vec());
        assert_eq!(
            read_request(&mut cursor).unwrap_err(),
            RequestError::UnsupportedVerb(42)
        );
        let mut cursor = Cursor::new(b"{\"verb\":\"status\"}\n".to_vec());
        assert_eq!(
            read_request(&mut cursor).unwrap_err(),
            RequestError::Frame(FrameError::Invalid)
        );
        let mut cursor = Cursor::new(b"{\"id\":1,\"verb\":\"status\",\"command\":\"rm -rf /\"}\n".to_vec());
        assert_eq!(
            read_request(&mut cursor).unwrap_err(),
            RequestError::UnsupportedVerb(1)
        );
    }

    #[test]
    fn unknown_verb_is_rejected_at_parse_time() {
        let result: Result<Request, _> = serde_json::from_str(r#"{"id":1,"verb":"run_shell"}"#);
        assert!(result.is_err());
    }

    #[test]
    fn frame_limit_is_enforced_on_read() {
        let mut oversized = vec![b'a'; MAX_FRAME + 16];
        oversized.push(b'\n');
        let mut cursor = Cursor::new(oversized);
        let result: Result<Request, _> = read_frame(&mut cursor);
        assert_eq!(result.unwrap_err(), FrameError::TooLarge);
    }

    #[test]
    fn frame_limit_is_enforced_on_write() {
        let huge = "x".repeat(MAX_FRAME);
        let mut buffer = Vec::new();
        let error = write_frame(&mut buffer, &huge).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn closed_stream_is_reported_as_closed() {
        let mut cursor = Cursor::new(Vec::<u8>::new());
        let result: Result<Request, _> = read_frame(&mut cursor);
        assert_eq!(result.unwrap_err(), FrameError::Closed);
    }

    #[test]
    fn invalid_json_is_reported_as_invalid() {
        let mut cursor = Cursor::new(b"not json\n".to_vec());
        let result: Result<Request, _> = read_frame(&mut cursor);
        assert_eq!(result.unwrap_err(), FrameError::Invalid);
    }

    #[test]
    fn response_payloads_are_tagged() {
        let status = HelperStatus {
            enabled: true,
            os_enabled: true,
            listening: true,
            port: 22,
            owned: true,
            lifetime: SshLifetime::App,
            ..HelperStatus::default()
        };
        let json = serde_json::to_value(Response::status(9, status.clone())).unwrap();
        assert_eq!(json["payload"]["type"], "status");
        assert_eq!(json["payload"]["port"], 22);

        let decoded: Response = serde_json::from_value(json).unwrap();
        assert_eq!(decoded.payload, Payload::Status(status));

        let error = serde_json::to_value(Response::error(
            10,
            HelperError::new(ErrorCode::PortInUse),
        ))
        .unwrap();
        assert_eq!(error["payload"]["type"], "error");
        assert_eq!(error["payload"]["code"], "port_in_use");
    }

    #[test]
    fn state_file_roundtrip_fills_missing_fields() {
        let state: StateFile = serde_json::from_str(r#"{"desired":true,"port":2222}"#).unwrap();
        assert_eq!(state.version, STATE_VERSION);
        assert!(state.desired);
        assert_eq!(state.port, 2222);
        assert_eq!(state.lifetime, SshLifetime::App);
        assert!(!state.owned);
    }

    #[test]
    fn every_error_code_has_a_wire_name() {
        let codes = [
            (ErrorCode::UnsupportedOs, "unsupported_os"),
            (ErrorCode::UnsupportedCustomPort, "unsupported_custom_port"),
            (ErrorCode::NeedsAdmin, "needs_admin"),
            (ErrorCode::HelperUnavailable, "helper_unavailable"),
            (ErrorCode::HelperVersionMismatch, "helper_version_mismatch"),
            (ErrorCode::FeatureMissing, "feature_missing"),
            (ErrorCode::ServiceMissing, "service_missing"),
            (ErrorCode::ServiceStartFailed, "service_start_failed"),
            (ErrorCode::ServiceStopFailed, "service_stop_failed"),
            (ErrorCode::FirewallBlocked, "firewall_blocked"),
            (ErrorCode::PolicyBlocked, "policy_blocked"),
            (ErrorCode::PortInUse, "port_in_use"),
            (ErrorCode::Busy, "busy"),
            (ErrorCode::ReadOnly, "read_only"),
            (ErrorCode::Internal, "internal"),
            (ErrorCode::UnsupportedVerb, "unsupported_verb"),
            (ErrorCode::FrameTooLarge, "frame_too_large"),
            (ErrorCode::Timeout, "timeout"),
        ];
        for (code, name) in codes {
            assert_eq!(serde_json::to_string(&code).unwrap(), format!("\"{name}\""));
        }
    }

    fn frame_bytes<T: Serialize>(value: &T) -> Vec<u8> {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, value).unwrap();
        buffer
    }
}
