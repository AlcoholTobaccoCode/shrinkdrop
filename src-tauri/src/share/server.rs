//! 分享服务的 HTTP 路由、鉴权、目录浏览、zip 与缩略图。

use std::fs;
use std::io::Cursor;
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path as UrlPath, Query, Request, State};
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Semaphore};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use super::{ItemKind, SharedItem};

const PAGE: &str = include_str!("page.html");
const PAGE_CSS: &str = include_str!("page.css");
const PAGE_JS: &str = include_str!("page.js");
const CSP: &str = "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'";
const THUMB_MAX_BYTES: u64 = 20_000_000;
const ZIP_MAX_FILES: usize = 20_000;
const ZIP_MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const ZIP_TTL: Duration = Duration::from_secs(600);

/// 同一时间只允许一个目录打包，避免访客并发触发高 IO。
static ZIP_SLOT: Semaphore = Semaphore::const_new(1);

#[derive(Clone)]
pub struct Context {
    pub token: Arc<String>,
    pub items: Arc<RwLock<Vec<SharedItem>>>,
    pub port: u16,
    pub events: broadcast::Sender<()>,
    pub zip_dir: PathBuf,
}

pub fn router(context: Context) -> Router {
    Router::new()
        .route("/s/{token}", get(page))
        .route("/s/{token}/assets/app.css", get(stylesheet))
        .route("/s/{token}/assets/app.js", get(script))
        .route("/s/{token}/api/items", get(list_items))
        .route("/s/{token}/api/list", get(list_dir))
        .route("/s/{token}/api/download", get(download))
        .route("/s/{token}/api/thumb", get(thumbnail))
        .route("/s/{token}/api/events", get(events))
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

async fn page(State(_context): State<Context>, UrlPath(token): UrlPath<String>) -> Response {
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
struct ItemView {
    id: u32,
    kind: ItemKind,
    name: String,
    size: u64,
    modified: Option<u64>,
}

async fn list_items(State(context): State<Context>) -> Json<Vec<ItemView>> {
    let items = read_items(&context);
    Json(items.iter().map(item_view).collect())
}

fn item_view(item: &SharedItem) -> ItemView {
    ItemView {
        id: item.id,
        kind: item.kind,
        name: item.name.clone(),
        size: item.size,
        modified: item.modified,
    }
}

#[derive(Deserialize)]
struct ItemQuery {
    id: u32,
    #[serde(default)]
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryView {
    name: String,
    kind: ItemKind,
    size: u64,
    modified: Option<u64>,
    /// 相对分享根目录的路径，使用 `/` 分隔。
    path: String,
    thumb: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListView {
    id: u32,
    name: String,
    /// 当前目录相对根目录的路径段，用于面包屑。
    path: Vec<String>,
    entries: Vec<EntryView>,
}

async fn list_dir(
    State(context): State<Context>,
    Query(query): Query<ItemQuery>,
) -> Result<Json<ListView>, StatusCode> {
    let root = find_item(&context, query.id)?;
    let dir = resolve_path(&root, &query.path)?;
    let meta = fs::metadata(&dir).map_err(|_| StatusCode::NOT_FOUND)?;
    if !meta.is_dir() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let mut entries = Vec::new();
    let reader = fs::read_dir(&dir).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    for entry in reader.flatten() {
        let Ok(canonical) = entry.path().canonicalize() else {
            continue;
        };
        if canonical == root.path || !canonical.starts_with(&root.path) {
            continue;
        }
        let Ok(meta) = fs::metadata(&canonical) else {
            continue;
        };
        let kind = if meta.is_dir() {
            ItemKind::Dir
        } else if meta.is_file() {
            ItemKind::File
        } else {
            continue;
        };
        let Ok(relative) = canonical.strip_prefix(&root.path) else {
            continue;
        };
        let path = relative.to_string_lossy().replace('\\', "/");
        let name = entry.file_name().to_string_lossy().into_owned();
        entries.push(EntryView {
            name,
            kind,
            size: if kind == ItemKind::File {
                meta.len()
            } else {
                0
            },
            modified: meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs()),
            thumb: kind == ItemKind::File && is_image(&canonical),
            path,
        });
    }
    entries.sort_by(|left, right| {
        let left_dir = left.kind == ItemKind::Dir;
        let right_dir = right.kind == ItemKind::Dir;
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    let path = relative_segments(&root, &dir);
    Ok(Json(ListView {
        id: root.id,
        name: root.name.clone(),
        path,
        entries,
    }))
}

async fn download(
    State(context): State<Context>,
    Query(query): Query<ItemQuery>,
    request: Request,
) -> Response {
    let Ok(root) = find_item(&context, query.id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(target) = resolve_path(&root, &query.path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(meta) = fs::metadata(&target) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    if meta.is_dir() {
        let name = target
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.name.clone());
        let Ok(zip_path) = build_zip_for(&context, &target).await else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        let download_name = if name.to_lowercase().ends_with(".zip") {
            name
        } else {
            format!("{name}.zip")
        };
        return serve_file(zip_path, download_name, request).await;
    }

    let name = target
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.name.clone());
    serve_file(target, name, request).await
}

async fn serve_file(path: PathBuf, name: String, request: Request) -> Response {
    let mut response = match ServeFile::new(&path).oneshot(request).await {
        Ok(response) => response.map(Body::new),
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    if let Ok(value) = HeaderValue::from_str(&content_disposition(&name)) {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, value);
    }
    response
}

async fn thumbnail(State(context): State<Context>, Query(query): Query<ItemQuery>) -> Response {
    let Ok(root) = find_item(&context, query.id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(target) = resolve_path(&root, &query.path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(meta) = fs::metadata(&target) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !meta.is_file() || meta.len() > THUMB_MAX_BYTES || !is_image(&target) {
        return StatusCode::NOT_FOUND.into_response();
    }

    let bytes = tauri::async_runtime::spawn_blocking(move || render_thumb(&target))
        .await
        .ok()
        .and_then(Result::ok);
    let Some(bytes) = bytes else {
        return StatusCode::NOT_FOUND.into_response();
    };
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg")),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=3600"),
            ),
        ],
        Body::from(bytes),
    )
        .into_response()
}

fn render_thumb(path: &FsPath) -> Result<Vec<u8>, String> {
    let image = image::ImageReader::open(path)
        .map_err(|_| "无法读取图片".to_string())?
        .with_guessed_format()
        .map_err(|_| "无法识别图片".to_string())?
        .decode()
        .map_err(|_| "无法解码图片".to_string())?;
    let thumb = image.thumbnail(200, 200);
    let mut buffer = Vec::new();
    let mut cursor = Cursor::new(&mut buffer);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 72);
    encoder
        .encode_image(&thumb)
        .map_err(|_| "无法生成缩略图".to_string())?;
    Ok(buffer)
}

async fn events(
    State(context): State<Context>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let receiver = context.events.subscribe();
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        let event = match tokio::time::timeout(Duration::from_secs(15), receiver.recv()).await {
            Ok(Ok(())) => Event::default().event("update").data("1"),
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                Event::default().event("update").data("1")
            }
            Ok(Err(broadcast::error::RecvError::Closed)) => return None,
            Err(_) => Event::default().comment("ping"),
        };
        Some((Ok::<_, std::convert::Infallible>(event), receiver))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

fn read_items(context: &Context) -> Vec<SharedItem> {
    context
        .items
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

fn find_item(context: &Context, id: u32) -> Result<SharedItem, StatusCode> {
    read_items(context)
        .into_iter()
        .find(|item| item.id == id)
        .ok_or(StatusCode::NOT_FOUND)
}

/// 把访客给的相对路径限制在分享根目录内，拒绝 `..`、反斜杠与越界软链。
fn resolve_path(root: &SharedItem, relative: &str) -> Result<PathBuf, StatusCode> {
    let mut path = root.path.clone();
    for segment in relative.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." || segment.contains('\\') || segment.contains('\0') {
            return Err(StatusCode::BAD_REQUEST);
        }
        path.push(segment);
    }
    let canonical = path.canonicalize().map_err(|_| StatusCode::NOT_FOUND)?;
    match root.kind {
        ItemKind::File => {
            if canonical == root.path {
                Ok(canonical)
            } else {
                Err(StatusCode::NOT_FOUND)
            }
        }
        ItemKind::Dir => {
            if canonical.starts_with(&root.path) {
                Ok(canonical)
            } else {
                Err(StatusCode::NOT_FOUND)
            }
        }
    }
}

fn relative_segments(root: &SharedItem, target: &FsPath) -> Vec<String> {
    target
        .strip_prefix(&root.path)
        .map(|relative| {
            relative
                .components()
                .filter_map(|component| component.as_os_str().to_str())
                .map(|value| value.to_string())
                .collect()
        })
        .unwrap_or_default()
}

async fn build_zip_for(context: &Context, dir: &FsPath) -> Result<PathBuf, ()> {
    let _permit = ZIP_SLOT.acquire().await.map_err(|_| ())?;
    fs::create_dir_all(&context.zip_dir).map_err(|_| ())?;
    let name = random_suffix();
    let destination = context.zip_dir.join(format!("{name}.zip"));
    let source = dir.to_path_buf();
    let target = destination.clone();
    tauri::async_runtime::spawn_blocking(move || build_zip(&source, &target))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;

    // 十分钟后清理临时包；下载已经建立的文件句柄不受影响。
    let cleanup = destination.clone();
    tokio::spawn(async move {
        tokio::time::sleep(ZIP_TTL).await;
        let _ = fs::remove_file(cleanup);
    });
    Ok(destination)
}

fn build_zip(root: &FsPath, destination: &FsPath) -> Result<(), String> {
    let file = fs::File::create(destination).map_err(|error| error.to_string())?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let base = root.parent().unwrap_or(root);

    let mut files = 0usize;
    let mut total = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(current) = stack.pop() {
        let reader = fs::read_dir(&current).map_err(|error| error.to_string())?;
        for entry in reader.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let name = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if file_type.is_dir() {
                writer
                    .add_directory(format!("{name}/"), options)
                    .map_err(|error| error.to_string())?;
                stack.push(path);
            } else if file_type.is_file() {
                files += 1;
                let length = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
                total += length;
                if files > ZIP_MAX_FILES || total > ZIP_MAX_BYTES {
                    return Err("分享内容过大，暂时无法打包".to_string());
                }
                writer
                    .start_file(name, options)
                    .map_err(|error| error.to_string())?;
                let mut source = fs::File::open(&path).map_err(|error| error.to_string())?;
                std::io::copy(&mut source, &mut writer).map_err(|error| error.to_string())?;
            }
        }
    }
    writer.finish().map_err(|error| error.to_string())?;
    Ok(())
}

fn is_image(path: &FsPath) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .is_some_and(|value| matches!(value.as_str(), "png" | "jpg" | "jpeg" | "webp"))
}

fn random_suffix() -> String {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return format!("{:x}", std::process::id());
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
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
    use std::collections::HashSet;

    use super::*;

    fn fixture_dir() -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "tinypng-share-server-test-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

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

    #[test]
    fn resolve_rejects_traversal_and_escapes() {
        let root = fixture_dir().canonicalize().unwrap();
        fs::write(root.join("inside.txt"), b"ok").unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/nested.txt"), b"ok").unwrap();

        let item = SharedItem {
            id: 1,
            kind: ItemKind::Dir,
            name: "root".to_string(),
            path: root.clone(),
            size: 0,
            modified: None,
        };

        assert!(resolve_path(&item, "").is_ok());
        assert!(resolve_path(&item, "inside.txt").is_ok());
        assert!(resolve_path(&item, "sub/nested.txt").is_ok());
        assert_eq!(
            resolve_path(&item, "../outside"),
            Err(StatusCode::BAD_REQUEST)
        );
        assert_eq!(
            resolve_path(&item, "sub/../../outside"),
            Err(StatusCode::BAD_REQUEST)
        );
        assert!(resolve_path(&item, "missing.txt").is_err());
    }

    #[test]
    fn zip_contains_folder_prefixed_entries() {
        let root = fixture_dir();
        let folder = root.join("photos");
        fs::create_dir_all(folder.join("sub")).unwrap();
        fs::write(folder.join("a.txt"), b"aaa").unwrap();
        fs::write(folder.join("sub/b.txt"), b"bbb").unwrap();

        let zip_path = root.join("out.zip");
        build_zip(&folder, &zip_path).unwrap();

        let file = fs::File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names: HashSet<String> = (0..archive.len())
            .filter_map(|index| {
                archive
                    .by_index(index)
                    .ok()
                    .map(|entry| entry.name().to_string())
            })
            .collect();
        assert!(names.contains("photos/a.txt"));
        assert!(names.contains("photos/sub/b.txt"));
    }

    #[test]
    fn image_detection_is_limited_to_supported_types() {
        assert!(is_image(FsPath::new("a.PNG")));
        assert!(is_image(FsPath::new("a.jpeg")));
        assert!(!is_image(FsPath::new("a.gif")));
        assert!(!is_image(FsPath::new("a.txt")));
    }
}
