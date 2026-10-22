//! 分享服务的 HTTP 路由、鉴权、目录浏览、上传、zip 与缩略图。

use std::fs;
use std::io::Cursor;
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Multipart, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, Semaphore};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use super::auth::{self, AuthConfig, Claims, Permissions, Protection};
use super::{ItemKind, SharedItem};
use crate::settings::Language;

const PAGE: &str = include_str!("page.html");
const PAGE_CSS: &str = include_str!("page.css");
const PAGE_JS: &str = include_str!("page.js");
const CSP: &str = "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'";
const THUMB_MAX_BYTES: u64 = 20_000_000;
const ZIP_MAX_FILES: usize = 20_000;
const ZIP_MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const ZIP_TTL: Duration = Duration::from_secs(600);
const MAX_UPLOAD_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_UPLOAD_FILES: usize = 20;
const MAX_TEXT_CHARS: usize = 10_000;

/// 同一时间只允许一个目录打包，避免访客并发触发高 IO。
static ZIP_SLOT: Semaphore = Semaphore::const_new(1);

#[derive(Clone)]
pub struct Context {
    pub base: String,
    pub cookie_path: String,
    pub items: Arc<RwLock<Vec<SharedItem>>>,
    pub port: u16,
    pub events: broadcast::Sender<()>,
    pub zip_dir: PathBuf,
    pub auth: Arc<AuthConfig>,
    pub next_id: Arc<AtomicU32>,
    pub upload_dir: PathBuf,
    pub language: Arc<RwLock<Language>>,
    pub public: bool,
    pub auto_save_uploads: bool,
    pub app: Option<tauri::AppHandle>,
}

pub fn router(contexts: Vec<Context>) -> Router {
    let mut app = Router::new();
    for context in contexts {
        let base = context.base.clone();
        let state = context.clone();
        let routes = route_table()
            .with_state(context)
            .layer(middleware::from_fn_with_state(state, guard));
        if base.is_empty() {
            app = app.merge(routes);
        } else {
            app = app.nest(&base, routes);
        }
    }
    app
}

fn route_table() -> Router<Context> {
    Router::new()
        .route("/", get(page))
        .route("/assets/app.css", get(stylesheet))
        .route("/assets/app.js", get(script))
        .route("/api/state", get(state))
        .route("/api/unlock", post(unlock))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/items", get(list_items))
        .route("/api/list", get(list_dir))
        .route("/api/download", get(download))
        .route("/api/thumb", get(thumbnail))
        .route("/api/events", get(events))
        .route(
            "/api/upload",
            post(upload).layer(DefaultBodyLimit::max(
                (MAX_UPLOAD_BYTES + 1024 * 1024) as usize,
            )),
        )
        .route(
            "/api/text",
            post(add_text).layer(DefaultBodyLimit::max(64 * 1024)),
        )
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

//#region 页面与静态资源

async fn page(State(context): State<Context>) -> Response {
    let html = PAGE.replace("{{BASE}}", &context.base);
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
//#endregion

//#region 访客状态与登录

fn claims(context: &Context, headers: &HeaderMap) -> Option<Claims> {
    let token = auth::cookie_token(headers)?;
    auth::verify_claims(&context.auth.key, &token)
}

fn permissions(context: &Context, headers: &HeaderMap) -> Option<Permissions> {
    let claims = claims(context, headers);
    context.auth.permissions(claims.as_ref())
}

fn csrf_ok(headers: &HeaderMap) -> bool {
    headers
        .get("x-share-csrf")
        .and_then(|value| value.to_str().ok())
        == Some("1")
}

fn state_payload(context: &Context, headers: &HeaderMap) -> serde_json::Value {
    let claims = claims(context, headers);
    let permissions = context.auth.permissions(claims.as_ref());
    let account = claims
        .as_ref()
        .filter(|claims| claims.scope == "account")
        .and_then(|claims| claims.account.clone())
        .and_then(|id| {
            context
                .auth
                .accounts
                .iter()
                .find(|account| account.id == id && account.enabled)
                .map(|account| account.username.clone())
        });
    json!({
        "protection": context.auth.protection,
        "authenticated": context.auth.authenticated(claims.as_ref()),
        "account": account,
        "permissions": permissions,
        "lang": context
            .language
            .read()
            .map(|language| language.effective())
            .unwrap_or("zh"),
        "public": context.public,
        "upload": permissions.as_ref().map(|value| value.upload).unwrap_or(false),
        "text": permissions.as_ref().map(|value| value.text).unwrap_or(false),
    })
}

async fn state(State(context): State<Context>, headers: HeaderMap) -> Json<serde_json::Value> {
    Json(state_payload(&context, &headers))
}

#[derive(Deserialize)]
struct UnlockBody {
    pin: String,
}

#[derive(Deserialize)]
struct LoginBody {
    username: String,
    password: String,
}

fn session_cookie(context: &Context, claims: &Claims) -> Response {
    let token = auth::sign_claims(&context.auth.key, claims);
    let cookie = auth::cookie_header(&token, &context.cookie_path);
    let mut response = Json(json!({ "ok": true })).into_response();
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

async fn unlock(
    State(context): State<Context>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<UnlockBody>,
) -> Response {
    if context.auth.protection != Protection::Pin {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if !csrf_ok(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let ip = address.ip();
    if context.auth.locked(ip) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let Some(hash) = context.auth.pin_hash.as_deref() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if !auth::verify_secret(&body.pin, hash) {
        let locked = context.auth.record_failure(ip);
        return (if locked {
            StatusCode::TOO_MANY_REQUESTS
        } else {
            StatusCode::UNAUTHORIZED
        })
        .into_response();
    }
    context.auth.clear_failures(ip);
    session_cookie(
        &context,
        &Claims {
            scope: "pin".to_string(),
            account: None,
            expires: auth::expires_at(),
        },
    )
}

async fn login(
    State(context): State<Context>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Response {
    if context.auth.protection != Protection::Accounts {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if !csrf_ok(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let ip = address.ip();
    if context.auth.locked(ip) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let account = context
        .auth
        .accounts
        .iter()
        .find(|account| account.enabled && account.username == body.username.trim());
    let valid = account.is_some_and(|account| auth::secret_eq(&body.password, &account.password));
    let Some(account) = account.filter(|_| valid) else {
        let locked = context.auth.record_failure(ip);
        return (if locked {
            StatusCode::TOO_MANY_REQUESTS
        } else {
            StatusCode::UNAUTHORIZED
        })
        .into_response();
    };
    context.auth.clear_failures(ip);
    session_cookie(
        &context,
        &Claims {
            scope: "account".to_string(),
            account: Some(account.id.clone()),
            expires: auth::expires_at(),
        },
    )
}

async fn logout(State(context): State<Context>, headers: HeaderMap) -> Response {
    if !csrf_ok(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut response = Json(json!({ "ok": true })).into_response();
    if let Ok(value) = HeaderValue::from_str(&auth::clear_cookie(&context.cookie_path)) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}
//#endregion

//#region 分享列表

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemView {
    id: u32,
    kind: ItemKind,
    name: String,
    size: u64,
    modified: Option<u64>,
    text: Option<String>,
    visitor: bool,
}

async fn list_items(State(context): State<Context>, headers: HeaderMap) -> Response {
    let Some(permissions) = permissions(&context, &headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !permissions.download {
        return StatusCode::FORBIDDEN.into_response();
    }
    let items = read_items(&context);
    Json(
        items
            .iter()
            .map(|item| ItemView {
                id: item.id,
                kind: item.kind,
                name: item.name.clone(),
                size: item.size,
                modified: item.modified,
                text: item.text.clone(),
                visitor: item.visitor,
            })
            .collect::<Vec<_>>(),
    )
    .into_response()
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
    path: String,
    thumb: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListView {
    id: u32,
    name: String,
    path: Vec<String>,
    entries: Vec<EntryView>,
}

async fn list_dir(
    State(context): State<Context>,
    headers: HeaderMap,
    Query(query): Query<ItemQuery>,
) -> Response {
    let Some(permissions) = permissions(&context, &headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !permissions.download {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(root) = find_item(&context, query.id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if root.kind == ItemKind::Text {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let dir = match resolve_path(&root, &query.path) {
        Ok(dir) => dir,
        Err(status) => return status.into_response(),
    };
    let Ok(meta) = fs::metadata(&dir) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !meta.is_dir() {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let mut entries = Vec::new();
    let Ok(reader) = fs::read_dir(&dir) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
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
        entries.push(EntryView {
            name: entry.file_name().to_string_lossy().into_owned(),
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
            path: relative.to_string_lossy().replace('\\', "/"),
            thumb: kind == ItemKind::File && is_image(&canonical),
        });
    }
    entries.sort_by(|left, right| {
        let left_dir = left.kind == ItemKind::Dir;
        let right_dir = right.kind == ItemKind::Dir;
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Json(ListView {
        id: root.id,
        name: root.name.clone(),
        path: relative_segments(&root, &dir),
        entries,
    })
    .into_response()
}

async fn download(
    State(context): State<Context>,
    headers: HeaderMap,
    Query(query): Query<ItemQuery>,
    request: Request,
) -> Response {
    let Some(permissions) = permissions(&context, &headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !permissions.download {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(root) = find_item(&context, query.id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if root.kind == ItemKind::Text {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let target = match resolve_path(&root, &query.path) {
        Ok(target) => target,
        Err(status) => return status.into_response(),
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

async fn thumbnail(
    State(context): State<Context>,
    headers: HeaderMap,
    Query(query): Query<ItemQuery>,
) -> Response {
    let Some(permissions) = permissions(&context, &headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !permissions.download {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(root) = find_item(&context, query.id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let target = match resolve_path(&root, &query.path) {
        Ok(target) => target,
        Err(status) => return status.into_response(),
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
//#endregion

//#region 上传与文字

#[derive(Serialize)]
struct UploadedFile {
    name: String,
    size: u64,
}

async fn upload(
    State(context): State<Context>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Response {
    let Some(permissions) = permissions(&context, &headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !permissions.upload {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !csrf_ok(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if fs::create_dir_all(&context.upload_dir).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    let mut uploaded: Vec<UploadedFile> = Vec::new();
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => return StatusCode::BAD_REQUEST.into_response(),
        };
        let Some(raw_name) = field.file_name().map(|value| value.to_string()) else {
            continue;
        };
        if uploaded.len() >= MAX_UPLOAD_FILES {
            break;
        }
        let name = sanitize_filename(&raw_name);
        let Ok(path) = unique_path(&context.upload_dir, &name).await else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        let temp = context
            .upload_dir
            .join(format!(".{}.part", random_suffix()));
        let mut file = match tokio::fs::File::create(&temp).await {
            Ok(file) => file,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
        let mut size = 0u64;
        let mut field = field;
        let mut failed = false;
        while let Ok(Some(chunk)) = field.chunk().await {
            size += chunk.len() as u64;
            if size > MAX_UPLOAD_BYTES {
                failed = true;
                break;
            }
            if file.write_all(&chunk).await.is_err() {
                failed = true;
                break;
            }
        }
        if failed || size == 0 {
            let _ = tokio::fs::remove_file(&temp).await;
            if size > MAX_UPLOAD_BYTES {
                return StatusCode::PAYLOAD_TOO_LARGE.into_response();
            }
            continue;
        }
        if file.sync_all().await.is_err() {
            let _ = tokio::fs::remove_file(&temp).await;
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        drop(file);
        if tokio::fs::rename(&temp, &path).await.is_err() {
            let _ = tokio::fs::remove_file(&temp).await;
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        let modified = fs::metadata(&path).ok().and_then(|meta| {
            meta.modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs())
        });
        let id = context.next_id.fetch_add(1, Ordering::SeqCst);
        let display = path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| name.clone());
        if context.auto_save_uploads {
            let directory = super::download_dir();
            if fs::create_dir_all(&directory).is_ok() {
                let destination = super::unique_destination(&directory, &display);
                let _ = fs::copy(&path, destination);
            }
        }
        push_item(
            &context,
            SharedItem {
                id,
                kind: ItemKind::File,
                name: display.clone(),
                path,
                size,
                modified,
                text: None,
                visitor: true,
            },
        );
        uploaded.push(UploadedFile {
            name: display,
            size,
        });
    }

    Json(json!({ "uploaded": uploaded })).into_response()
}

#[derive(Deserialize)]
struct TextBody {
    text: String,
}

async fn add_text(
    State(context): State<Context>,
    headers: HeaderMap,
    Json(body): Json<TextBody>,
) -> Response {
    let Some(permissions) = permissions(&context, &headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !permissions.text {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !csrf_ok(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let text = body.text.trim().to_string();
    if text.is_empty() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let name: String = text.chars().take(32).collect();
    let id = context.next_id.fetch_add(1, Ordering::SeqCst);
    let modified = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs());
    push_item(
        &context,
        SharedItem {
            id,
            kind: ItemKind::Text,
            name,
            path: PathBuf::new(),
            size: 0,
            modified,
            text: Some(text),
            visitor: true,
        },
    );
    Json(json!({ "ok": true, "id": id })).into_response()
}

fn push_item(context: &Context, item: SharedItem) {
    if let Ok(mut items) = context.items.write() {
        items.push(item);
    }
    let _ = context.events.send(());
    if let Some(app) = context.app.as_ref() {
        use tauri::Emitter;
        let _ = app.emit("share-refresh", ());
    }
}

fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name).to_string();
    let cleaned: String = base.chars().filter(|value| !value.is_control()).collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim();
    let trimmed = trimmed.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() || trimmed == ".." {
        return "file".to_string();
    }
    trimmed.chars().take(120).collect()
}

async fn unique_path(directory: &FsPath, name: &str) -> Result<PathBuf, ()> {
    let path = directory.join(name);
    if tokio::fs::metadata(&path).await.is_err() {
        return Ok(path);
    }
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem.to_string(), format!(".{extension}")),
        _ => (name.to_string(), String::new()),
    };
    for index in 1..1000 {
        let candidate = directory.join(format!("{stem} ({index}){extension}"));
        if tokio::fs::metadata(&candidate).await.is_err() {
            return Ok(candidate);
        }
    }
    Err(())
}
//#endregion

//#region SSE

async fn events(State(context): State<Context>, headers: HeaderMap) -> Response {
    let allowed = permissions(&context, &headers).is_some();
    let receiver = context.events.subscribe();
    let language = context.language.clone();
    let stream = futures_util::stream::unfold(
        (receiver, allowed, language),
        |(mut receiver, allowed, language)| async move {
            if !allowed {
                return None;
            }
            let code = language
                .read()
                .map(|value| value.effective())
                .unwrap_or("zh");
            let event = match tokio::time::timeout(Duration::from_secs(15), receiver.recv()).await {
                Ok(Ok(())) => Event::default().event("update").data(code),
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                    Event::default().event("update").data(code)
                }
                Ok(Err(broadcast::error::RecvError::Closed)) => return None,
                Err(_) => Event::default().comment("ping"),
            };
            Some((
                Ok::<_, std::convert::Infallible>(event),
                (receiver, allowed, language),
            ))
        },
    );
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

//#endregion

//#region 路径与安全工具

fn resolve_path(root: &SharedItem, relative: &str) -> Result<PathBuf, StatusCode> {
    if root.kind == ItemKind::Text {
        return Err(StatusCode::BAD_REQUEST);
    }
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
        ItemKind::Text => Err(StatusCode::BAD_REQUEST),
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
    let destination = context.zip_dir.join(format!("{}.zip", random_suffix()));
    let source = dir.to_path_buf();
    let target = destination.clone();
    tauri::async_runtime::spawn_blocking(move || build_zip(&source, &target))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;

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
                total += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
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

fn random_suffix() -> String {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return format!("{:x}", std::process::id());
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn is_image(path: &FsPath) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .is_some_and(|value| matches!(value.as_str(), "png" | "jpg" | "jpeg" | "webp"))
}

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
//#endregion

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
            text: None,
            visitor: false,
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
    fn sanitizes_uploaded_filenames() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("..\\..\\evil.exe"), "evil.exe");
        assert_eq!(sanitize_filename("   ..  "), "file");
        assert_eq!(sanitize_filename("正常 文件.txt"), "正常 文件.txt");
        assert_eq!(sanitize_filename(".hidden"), "hidden");
    }

    #[test]
    fn image_detection_is_limited_to_supported_types() {
        assert!(is_image(FsPath::new("a.PNG")));
        assert!(is_image(FsPath::new("a.jpeg")));
        assert!(!is_image(FsPath::new("a.gif")));
        assert!(!is_image(FsPath::new("a.txt")));
    }
}
