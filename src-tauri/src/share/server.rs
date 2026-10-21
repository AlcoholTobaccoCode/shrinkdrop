//! 分享服务的 HTTP 路由、鉴权与安全响应头。

use std::sync::Arc;

use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use super::SharedFile;

const PAGE: &str = include_str!("page.html");
const PAGE_CSS: &str = include_str!("page.css");
const PAGE_JS: &str = include_str!("page.js");
const CSP: &str = "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'";

#[derive(Clone)]
pub struct Context {
    pub token: Arc<String>,
    pub files: Arc<Vec<SharedFile>>,
    pub port: u16,
}

pub fn router(context: Context) -> Router {
    Router::new()
        .route("/s/{token}", get(page))
        .route("/s/{token}/assets/app.css", get(stylesheet))
        .route("/s/{token}/assets/app.js", get(script))
        .route("/s/{token}/api/files", get(list_files))
        .route("/s/{token}/f/{id}", get(download))
        .with_state(context.clone())
        .layer(middleware::from_fn_with_state(context, guard))
}

/// 统一入口校验：Host 必须是 IP/localhost，路径 token 必须匹配。
async fn guard(State(context): State<Context>, request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    if !host_allowed(host, context.port) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !token_matches(request.uri().path(), &context.token) {
        return StatusCode::NOT_FOUND.into_response();
    }

    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    response
}

async fn page(State(_context): State<Context>, Path(token): Path<String>) -> Response {
    let base = format!("/s/{token}");
    let html = PAGE.replace("{{BASE}}", &base);
    (
        [
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static(CSP),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        Html(html),
    )
        .into_response()
}

async fn stylesheet() -> Response {
    (
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/css; charset=utf-8"),
        )],
        PAGE_CSS,
    )
        .into_response()
}

async fn script() -> Response {
    (
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/javascript; charset=utf-8"),
        )],
        PAGE_JS,
    )
        .into_response()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileView {
    id: u32,
    name: String,
    size: u64,
    url: String,
}

async fn list_files(
    State(context): State<Context>,
    Path(token): Path<String>,
) -> Json<Vec<FileView>> {
    let base = format!("/s/{token}");
    Json(
        context
            .files
            .iter()
            .map(|file| FileView {
                id: file.id,
                name: file.name.clone(),
                size: file.size,
                url: format!("{base}/f/{}", file.id),
            })
            .collect(),
    )
}

async fn download(
    State(context): State<Context>,
    Path((_token, id)): Path<(String, u32)>,
    request: Request,
) -> Response {
    let Some(file) = context.files.iter().find(|file| file.id == id) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let mut response = match ServeFile::new(&file.path).oneshot(request).await {
        Ok(response) => response.map(axum::body::Body::new),
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    if let Ok(value) = HeaderValue::from_str(&content_disposition(&file.name)) {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, value);
    }
    response
}

/// 只接受 IP 字面量或 localhost，端口必须与服务端口一致，防止 DNS rebinding。
fn host_allowed(host: Option<&str>, port: u16) -> bool {
    let Some(host) = host else {
        return false;
    };
    let (name, host_port) = if let Some(rest) = host.strip_prefix('[') {
        let Some((name, tail)) = rest.split_once(']') else {
            return false;
        };
        let port = tail
            .strip_prefix(':')
            .and_then(|value| value.parse::<u16>().ok());
        (name, port)
    } else if let Some((name, value)) = host.rsplit_once(':') {
        (name, value.parse::<u16>().ok())
    } else {
        (host, None)
    };

    if host_port != Some(port) {
        return false;
    }
    name.parse::<std::net::IpAddr>().is_ok() || name.eq_ignore_ascii_case("localhost")
}

fn token_matches(path: &str, token: &str) -> bool {
    let Some(candidate) = path
        .strip_prefix("/s/")
        .and_then(|rest| rest.split('/').next())
    else {
        return false;
    };
    constant_time_eq(candidate.as_bytes(), token.as_bytes())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |accumulator, (a, b)| accumulator | (a ^ b))
        == 0
}

/// `Content-Disposition` 同时给出 ASCII 回退名和 RFC 5987 的 UTF-8 名。
fn content_disposition(name: &str) -> String {
    let fallback: String = name
        .chars()
        .map(|value| {
            if value.is_ascii() && value != '"' && value != '\\' {
                value
            } else {
                '_'
            }
        })
        .collect();
    format!(
        "attachment; filename=\"{fallback}\"; filename*=UTF-8''{}",
        percent_encode(name)
    )
}

fn percent_encode(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(*byte as char)
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_must_be_ip_localhost_and_matching_port() {
        assert!(host_allowed(Some("192.168.1.5:5421"), 5421));
        assert!(host_allowed(Some("127.0.0.1:5421"), 5421));
        assert!(host_allowed(Some("localhost:5421"), 5421));
        assert!(host_allowed(Some("[::1]:5421"), 5421));
        assert!(!host_allowed(Some("evil.example.com:5421"), 5421));
        assert!(!host_allowed(Some("192.168.1.5:6000"), 5421));
        assert!(!host_allowed(None, 5421));
    }

    #[test]
    fn token_requires_exact_path_prefix() {
        assert!(token_matches("/s/abc/f/1", "abc"));
        assert!(token_matches("/s/abc", "abc"));
        assert!(!token_matches("/s/abd/f/1", "abc"));
        assert!(!token_matches("/s/abcx/f/1", "abc"));
        assert!(!token_matches("/other/abc", "abc"));
    }

    #[test]
    fn content_disposition_encodes_utf8_and_quotes() {
        let value = content_disposition("测试 \"1\".png");
        assert!(value.contains("filename=\"__ _1_.png\""), "{value}");
        assert!(value.contains("filename*=UTF-8''%E6%B5%8B%E8%AF%95%20%221%22.png"));
    }
}
