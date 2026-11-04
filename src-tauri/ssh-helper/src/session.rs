//! 一次客户端会话的协议循环（与传输层无关）。
//!
//! 生产环境里 `R`/`W` 是命名管道；测试里是 socket 对，因此协议本身可以在任意平台
//! 端到端验证。会话严格按顺序：第一条必须是 `hello` 且协议版本一致。

use std::io::{BufRead, Write};

use shrinkdrop_ssh_core::{
    read_request, write_frame, ErrorCode, Hello, HelperError, Payload, RequestError, Response,
    Verb, PROTOCOL,
};

use crate::helper::{Failure, Helper};

/// 为什么会话结束：正常（`shutdown_helper`）、对端关闭、或协议错误。
#[derive(Debug, PartialEq, Eq)]
pub enum SessionEnd {
    Shutdown,
    Closed,
    Protocol(String),
}

pub fn serve<R: BufRead, W: Write>(
    helper: &Helper,
    reader: &mut R,
    writer: &mut W,
) -> SessionEnd {
    let mut handshaken = false;
    // 本连接是否持有引用计数：连接断开（含进程崩溃）就等价于 detach，
    // 这样 `owned + app` 的实例不会因为 app 崩溃而永远开着。
    let mut attached = false;
    let end = serve_inner(helper, reader, writer, &mut handshaken, &mut attached);
    if attached {
        let _ = helper.detach();
    }
    end
}

fn serve_inner<R: BufRead, W: Write>(
    helper: &Helper,
    reader: &mut R,
    writer: &mut W,
    handshaken: &mut bool,
    attached: &mut bool,
) -> SessionEnd {
    loop {
        let request = match read_request(reader) {
            Ok(request) => request,
            Err(RequestError::UnsupportedVerb(id)) => {
                let response = Response::error(id, HelperError::new(ErrorCode::UnsupportedVerb));
                if write_frame(writer, &response).is_err() {
                    return SessionEnd::Closed;
                }
                continue;
            }
            Err(RequestError::Frame(error)) => {
                return match error {
                    shrinkdrop_ssh_core::FrameError::TooLarge => {
                        let _ = write_frame(
                            writer,
                            &Response::error(0, HelperError::new(ErrorCode::FrameTooLarge)),
                        );
                        SessionEnd::Protocol("frame_too_large".to_string())
                    }
                    _ => SessionEnd::Closed,
                };
            }
        };

        if !*handshaken {
            if request.verb != Verb::Hello {
                let _ = write_frame(
                    writer,
                    &Response::error(request.id, HelperError::new(ErrorCode::HelperVersionMismatch)),
                );
                return SessionEnd::Protocol("missing_hello".to_string());
            }
            let protocol = request.protocol.unwrap_or(0);
            if protocol != PROTOCOL {
                let _ = write_frame(
                    writer,
                    &Response::error(request.id, HelperError::new(ErrorCode::HelperVersionMismatch)),
                );
                return SessionEnd::Protocol("version_mismatch".to_string());
            }
            let hello = Hello {
                helper_version: env!("CARGO_PKG_VERSION").to_string(),
                protocol: PROTOCOL,
            };
            if write_frame(writer, &Response { id: request.id, payload: Payload::Hello(hello) })
                .is_err()
            {
                return SessionEnd::Closed;
            }
            *handshaken = true;
            continue;
        }

        if request.verb == Verb::Attach {
            *attached = true;
        } else if request.verb == Verb::Detach {
            *attached = false;
        }
        let (response, end) = dispatch(helper, &request);
        if write_frame(writer, &response).is_err() {
            return SessionEnd::Closed;
        }
        if let Some(end) = end {
            return end;
        }
    }
}

fn dispatch(helper: &Helper, request: &shrinkdrop_ssh_core::Request) -> (Response, Option<SessionEnd>) {
    let id = request.id;
    match request.verb {
        Verb::Hello => (
            Response::error(id, HelperError::new(ErrorCode::UnsupportedVerb)),
            None,
        ),
        Verb::Status => (reply(id, helper.status()), None),
        Verb::Enable => (
            reply(
                id,
                helper.enable(request.lifetime.unwrap_or_default(), request.port.unwrap_or(22)),
            ),
            None,
        ),
        Verb::Disable => (reply(id, helper.disable()), None),
        Verb::SetLifetime => (
            reply(id, helper.set_lifetime(request.lifetime.unwrap_or_default())),
            None,
        ),
        Verb::SetPort => (reply(id, helper.set_port(request.port.unwrap_or(22))), None),
        Verb::Attach => (
            match helper.attach() {
                Ok(()) => Response::ack(id),
                Err(error) => Response::error(id, error.to_helper_error()),
            },
            None,
        ),
        Verb::Detach => (
            match helper.detach() {
                Ok(()) => Response::ack(id),
                Err(error) => Response::error(id, error.to_helper_error()),
            },
            None,
        ),
        // 卸载前先把系统改回原样：关掉自己开的实例、还原配置与启动类型。
        Verb::InstallBundled => (
            match helper.install_bundled().and_then(|()| helper.status()) {
                Ok(status) => Response::status(id, status),
                Err(error) => Response::error(id, error.to_helper_error()),
            },
            None,
        ),
        Verb::ShutdownHelper => (
            match helper.uninstall() {
                Ok(()) => Response::ack(id),
                Err(error) => Response::error(id, error.to_helper_error()),
            },
            Some(SessionEnd::Shutdown),
        ),
    }
}

fn reply(
    id: u64,
    result: Result<shrinkdrop_ssh_core::HelperStatus, Failure>,
) -> Response {
    match result {
        Ok(status) => Response::status(id, status),
        Err(error) => Response::error(id, error.to_helper_error()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::helper::Helper;
    use crate::testing::Fake;
    use shrinkdrop_ssh_core::{Request, SshLifetime};
    use std::sync::Arc;

    fn setup() -> (Arc<Fake>, Helper) {
        let fake = Arc::new(Fake::new());
        let helper = Helper::new(fake.clone(), fake.clone(), fake.clone(), "config", "state.json");
        (fake, helper)
    }

    /// 一次会话：把请求帧喂进去，返回解析出来的响应。
    fn roundtrip(helper: &Helper, requests: &[Request]) -> (Vec<Response>, SessionEnd) {
        let mut input = Vec::new();
        for request in requests {
            write_frame(&mut input, request).unwrap();
        }
        let mut reader = std::io::BufReader::new(std::io::Cursor::new(input));
        let mut output = Vec::new();
        let end = serve(helper, &mut reader, &mut output);
        let responses = output
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice::<Response>(line).unwrap())
            .collect();
        (responses, end)
    }

    fn hello(id: u64) -> Request {
        Request::hello(id, "0.1.6")
    }

    fn status(id: u64) -> Request {
        Request::new(id, Verb::Status)
    }

    #[test]
    fn hello_must_come_first() {
        let (_, helper) = setup();
        let (responses, end) = roundtrip(&helper, &[status(1)]);
        assert_eq!(end, SessionEnd::Protocol("missing_hello".to_string()));
        assert_eq!(responses.len(), 1);
        assert_eq!(
            responses[0].payload,
            Payload::Error(HelperError::new(ErrorCode::HelperVersionMismatch))
        );
    }

    #[test]
    fn protocol_version_must_match() {
        let (_, helper) = setup();
        let mut request = hello(1);
        request.protocol = Some(PROTOCOL + 1);
        let (responses, end) = roundtrip(&helper, &[request]);
        assert_eq!(end, SessionEnd::Protocol("version_mismatch".to_string()));
        assert_eq!(
            responses[0].payload,
            Payload::Error(HelperError::new(ErrorCode::HelperVersionMismatch))
        );
    }

    #[test]
    fn handshake_then_status_returns_snapshot() {
        let (_, helper) = setup();
        let (responses, end) = roundtrip(&helper, &[hello(1), status(2)]);
        assert_eq!(end, SessionEnd::Closed, "输入结束后会话自然结束");
        assert!(matches!(responses[0].payload, Payload::Hello(_)));
        assert!(matches!(responses[1].payload, Payload::Status(_)));
        assert_eq!(responses[1].id, 2);
    }

    #[test]
    fn unsupported_verb_is_rejected_without_executing() {
        let (_, helper) = setup();
        let mut input = Vec::new();
        write_frame(&mut input, &hello(1)).unwrap();
        // 带自由文本命令的帧：协议拒绝，不执行。
        input.extend_from_slice(b"{\"id\":7,\"verb\":\"exec\",\"command\":\"whoami\"}\n");
        let mut reader = std::io::BufReader::new(std::io::Cursor::new(input));
        let mut output = Vec::new();
        let end = serve(&helper, &mut reader, &mut output);
        assert_eq!(end, SessionEnd::Closed);
        let text = String::from_utf8(output).unwrap();
        assert!(text.contains("unsupported_verb"));
        assert!(text.contains("\"id\":7"));
    }

    #[test]
    fn shutdown_helper_ends_the_session() {
        let (_, helper) = setup();
        let (responses, end) = roundtrip(
            &helper,
            &[
                hello(1),
                Request::new(2, Verb::ShutdownHelper),
            ],
        );
        assert_eq!(end, SessionEnd::Shutdown);
        assert_eq!(responses[1].payload, Payload::Ack);
    }

    #[test]
    fn enable_through_protocol_returns_status() {
        let (fake, helper) = setup();
        let (responses, _) = roundtrip(
            &helper,
            &[
                hello(1),
                Request::new(2, Verb::Enable)
                    .with_lifetime(SshLifetime::Persistent)
                    .with_port(2222),
            ],
        );
        match &responses[1].payload {
            Payload::Status(status) => {
                assert!(status.enabled);
                assert_eq!(status.port, 2222);
            }
            other => panic!("expected status, got {other:?}"),
        }
        assert!(fake.lock().config.contains("Port 2222"));
    }

    #[test]
    fn enable_error_is_returned_as_error_payload() {
        let (fake, helper) = setup();
        fake.occupy(2222, 999, "nginx.exe");
        let (responses, _) = roundtrip(
            &helper,
            &[
                hello(1),
                Request::new(2, Verb::Enable)
                    .with_lifetime(SshLifetime::Persistent)
                    .with_port(2222),
            ],
        );
        match &responses[1].payload {
            Payload::Error(error) => assert_eq!(error.code, ErrorCode::PortInUse),
            other => panic!("expected error, got {other:?}"),
        }
    }

    #[test]
    fn connection_close_detaches_so_a_crash_does_not_leave_sshd_running() {
        let (_, helper) = setup();
        // 模拟 app 崩溃：attach 之后直接断开，没有 detach。
        let (_, end) = roundtrip(
            &helper,
            &[
                hello(1),
                Request::new(2, Verb::Attach),
                Request::new(3, Verb::Status),
            ],
        );
        assert_eq!(end, SessionEnd::Closed);
        assert!(
            !helper.status().unwrap().os_enabled,
            "会话断开必须等价于 detach：app 崩溃后 owned 的实例要关掉"
        );
    }

    #[test]
    fn connection_close_keeps_persistent_instance() {
        let (_, helper) = setup();
        helper.enable(SshLifetime::Persistent, 22).unwrap();
        let (_, _) = roundtrip(
            &helper,
            &[hello(1), Request::new(2, Verb::Attach), Request::new(3, Verb::Status)],
        );
        assert!(helper.status().unwrap().os_enabled, "常驻实例不受会话结束影响");
    }

    #[test]
    fn oversized_frame_is_rejected() {
        let (_, helper) = setup();
        let mut input = Vec::new();
        write_frame(&mut input, &hello(1)).unwrap();
        input.extend_from_slice(&vec![b'x'; shrinkdrop_ssh_core::MAX_FRAME + 16]);
        let mut reader = std::io::BufReader::new(std::io::Cursor::new(input));
        let mut output = Vec::new();
        let end = serve(&helper, &mut reader, &mut output);
        assert_eq!(end, SessionEnd::Protocol("frame_too_large".to_string()));
    }
}
