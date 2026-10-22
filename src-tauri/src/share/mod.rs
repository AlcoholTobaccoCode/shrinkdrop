//! 局域网分享面：进程内 HTTP 服务、分享列表与生命周期。
//!
//! 参考 file-share 的能力形状，服务端用 axum 重写；压缩链路保持原样。

pub mod auth;
mod net;
mod server;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, watch};

use crate::settings::{Language, SettingsState};
use auth::{Account, AuthConfig, Protection};

const DEFAULT_PORT: u16 = 5421;
const MAX_SHARED_ITEMS: usize = 200;
/// 停止服务时等待在途下载的时间。
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    File,
    Dir,
    Text,
}

/// 分享中的一个文件、目录或文字。真实路径只留在 Rust 侧。
#[derive(Clone)]
pub struct SharedItem {
    pub id: u32,
    pub kind: ItemKind,
    pub name: String,
    pub path: PathBuf,
    pub size: u64,
    pub modified: Option<u64>,
    pub text: Option<String>,
    pub visitor: bool,
}

/// 下发给前端的描述，不含本机路径。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedItemView {
    pub id: u32,
    pub kind: ItemKind,
    pub name: String,
    pub size: u64,
    pub modified: Option<u64>,
    pub text: Option<String>,
    pub visitor: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupStatus {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub url: String,
    pub public: bool,
    pub protection: Protection,
    pub items: Vec<SharedItemView>,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShareStatus {
    pub running: bool,
    pub url: Option<String>,
    pub port: Option<u16>,
    pub items: Vec<SharedItemView>,
    /// 所有候选局域网地址，前端用于切换网卡。
    pub addresses: Vec<String>,
    /// 可用时返回 IPv6 候选地址，已带方括号。
    pub ipv6_addresses: Vec<String>,
    pub warning: Option<String>,
    pub active_group: String,
    pub groups: Vec<GroupStatus>,
}

#[derive(Clone)]
pub struct GroupOptions {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub upload_dir: PathBuf,
    pub public: bool,
    pub protection: Protection,
    pub pin_hash: Option<String>,
    pub allow_upload: bool,
    pub allow_text: bool,
}

#[derive(Clone)]
pub struct ShareOptions {
    pub port: u16,
    pub protection: Protection,
    pub public: bool,
    pub pin_hash: Option<String>,
    pub allow_upload: bool,
    pub allow_text: bool,
    pub auto_save_uploads: bool,
    pub accounts: Vec<Account>,
    pub upload_dir: PathBuf,
    pub language: Language,
    pub groups: Vec<GroupOptions>,
}

struct RuntimeGroup {
    options: GroupOptions,
    base: String,
    url: String,
    public: bool,
    protection: Protection,
    items: Arc<RwLock<Vec<SharedItem>>>,
    next_id: Arc<AtomicU32>,
    events: broadcast::Sender<()>,
}

struct Running {
    token: String,
    port: u16,
    addresses: Vec<String>,
    ipv6_addresses: Vec<String>,
    groups: Vec<RuntimeGroup>,
    active_group: String,
    shutdown: watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Default)]
pub struct ShareManager {
    running: Mutex<Option<Running>>,
    language: Arc<RwLock<Language>>,
}

fn shared_temp_dir(token: &str) -> PathBuf {
    std::env::temp_dir().join(format!("tinypng-share-{token}"))
}

impl ShareManager {
    pub async fn start(
        &self,
        paths: Vec<String>,
        options: ShareOptions,
        app: Option<AppHandle>,
    ) -> Result<ShareStatus, String> {
        let items = collect_items(paths)?;
        let active = options
            .groups
            .first()
            .map(|group| group.id.clone())
            .ok_or_else(|| "至少需要一个分享分组".to_string())?;
        let mut initial = HashMap::new();
        initial.insert(active.clone(), items);
        self.spawn_server(initial, options, active, app).await
    }

    /// 设置变更后重启服务，保留各分组的分享列表（含文字与上传项）。
    pub async fn restart(
        &self,
        options: ShareOptions,
        app: Option<AppHandle>,
    ) -> Result<ShareStatus, String> {
        let Some(previous) = self.take_running().await else {
            return Err("分享还没有开始".to_string());
        };
        let active = previous.active_group.clone();
        let mut snapshots = HashMap::new();
        for group in &previous.groups {
            let items = group
                .items
                .read()
                .map(|guard| guard.clone())
                .unwrap_or_default();
            snapshots.insert(group.options.id.clone(), items);
        }
        self.spawn_server(snapshots, options, active, app).await
    }

    fn active_group<'a>(running: &'a Running) -> Result<&'a RuntimeGroup, String> {
        running
            .groups
            .iter()
            .find(|group| group.options.id == running.active_group)
            .or_else(|| running.groups.first())
            .ok_or_else(|| "分享分组不可用".to_string())
    }

    pub fn snapshot_items(&self, ids: &[u32]) -> Result<Vec<SharedItem>, String> {
        let guard = self
            .running
            .lock()
            .map_err(|_| "分享状态不可用".to_string())?;
        let Some(running) = guard.as_ref() else {
            return Err("分享还没有开始".to_string());
        };
        let group = Self::active_group(running)?;
        let items = group
            .items
            .read()
            .map_err(|_| "分享列表不可用".to_string())?;
        let selected: Vec<SharedItem> = items
            .iter()
            .filter(|item| ids.contains(&item.id) && item.kind != ItemKind::Text)
            .cloned()
            .collect();
        if selected.is_empty() {
            return Err("请选择要保存的文件或文件夹".to_string());
        }
        Ok(selected)
    }

    pub fn active_upload_dir(&self) -> Result<PathBuf, String> {
        let guard = self
            .running
            .lock()
            .map_err(|_| "分享状态不可用".to_string())?;
        let Some(running) = guard.as_ref() else {
            return Err("分享还没有开始".to_string());
        };
        let group = Self::active_group(running)?;
        let dir = group.options.upload_dir.clone();
        fs::create_dir_all(&dir).map_err(|_| "无法创建接收目录".to_string())?;
        Ok(dir)
    }

    pub fn set_active_group(&self, group_id: String) -> Result<ShareStatus, String> {
        let mut guard = self
            .running
            .lock()
            .map_err(|_| "分享状态不可用".to_string())?;
        let Some(running) = guard.as_mut() else {
            return Err("分享还没有开始".to_string());
        };
        if !running
            .groups
            .iter()
            .any(|group| group.options.id == group_id)
        {
            return Err("分组不存在".to_string());
        }
        running.active_group = group_id;
        Ok(status_from(running))
    }

    pub fn add_text(&self, text: String) -> Result<(), String> {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err("文字不能为空".to_string());
        }
        if text.chars().count() > 10_000 {
            return Err("文字不能超过 1 万字".to_string());
        }
        let guard = self
            .running
            .lock()
            .map_err(|_| "分享状态不可用".to_string())?;
        let Some(running) = guard.as_ref() else {
            return Err("分享还没有开始".to_string());
        };
        let group = Self::active_group(running)?;
        let name: String = text.chars().take(32).collect();
        let id = group.next_id.fetch_add(1, Ordering::SeqCst);
        let modified = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|duration| duration.as_secs());
        if let Ok(mut items) = group.items.write() {
            items.push(SharedItem {
                id,
                kind: ItemKind::Text,
                name,
                path: PathBuf::new(),
                size: 0,
                modified,
                text: Some(text),
                visitor: false,
            });
        }
        let _ = group.events.send(());
        Ok(())
    }

    pub fn set_language(&self, language: Language) {
        if let Ok(mut guard) = self.language.write() {
            *guard = language;
        }
        if let Ok(guard) = self.running.lock() {
            if let Some(running) = guard.as_ref() {
                for group in &running.groups {
                    let _ = group.events.send(());
                }
            }
        }
    }

    async fn spawn_server(
        &self,
        snapshots: HashMap<String, Vec<SharedItem>>,
        options: ShareOptions,
        active_group: String,
        app: Option<AppHandle>,
    ) -> Result<ShareStatus, String> {
        if options.groups.is_empty() {
            return Err("至少需要一个分享分组".to_string());
        }
        let (listener, port) = bind_listener(options.port).await?;
        let listener6 = bind_listener_v6(port);
        let addresses = net::candidate_addresses();
        let ipv6_addresses = if listener6.is_some() {
            net::candidate_addresses_v6()
        } else {
            Vec::new()
        };
        let primary = addresses
            .first()
            .cloned()
            .unwrap_or_else(|| "127.0.0.1".to_string());
        let token = random_token();
        let temp_root = shared_temp_dir(&token);
        let mut contexts = Vec::new();
        let mut groups = Vec::new();
        for group in options.groups.clone() {
            let base = if group.slug.is_empty() {
                String::new()
            } else {
                format!("/g/{}", group.slug)
            };
            let url = format!("http://{primary}:{port}{base}");
            let items = snapshots.get(&group.id).cloned().unwrap_or_default();
            let next_id = Arc::new(AtomicU32::new(
                items.iter().map(|item| item.id).max().unwrap_or(0) + 1,
            ));
            let items = Arc::new(RwLock::new(items));
            let (events, _) = broadcast::channel(16);
            let auth = Arc::new(AuthConfig::new(
                group.protection,
                group.public,
                group.pin_hash.clone(),
                options.accounts.clone(),
                group.allow_upload,
                group.allow_text,
            ));
            contexts.push(server::Context {
                base: base.clone(),
                cookie_path: if base.is_empty() {
                    "/".to_string()
                } else {
                    base.clone()
                },
                items: items.clone(),
                port,
                events: events.clone(),
                zip_dir: temp_root.join(&group.id),
                auth,
                next_id: next_id.clone(),
                upload_dir: group.upload_dir.clone(),
                language: self.language.clone(),
                public: group.public,
                auto_save_uploads: options.auto_save_uploads,
                app: app.clone(),
            });
            groups.push(RuntimeGroup {
                public: group.public,
                protection: group.protection,
                options: group,
                base,
                url,
                items,
                next_id,
                events,
            });
        }
        if let Ok(mut language) = self.language.write() {
            *language = options.language;
        }
        let router = server::router(contexts);

        let (shutdown, mut rx4) = watch::channel(false);
        let mut rx6 = rx4.clone();
        let router6 = router.clone();
        let task = tokio::spawn(async move {
            let served = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .with_graceful_shutdown(async move {
                let _ = rx4.changed().await;
            });
            match listener6 {
                Some(listener6) => {
                    let served6 = axum::serve(
                        listener6,
                        router6.into_make_service_with_connect_info::<std::net::SocketAddr>(),
                    )
                    .with_graceful_shutdown(async move {
                        let _ = rx6.changed().await;
                    });
                    let _ = tokio::join!(served, served6);
                }
                None => {
                    let _ = served.await;
                }
            }
        });

        let active_group = if groups.iter().any(|group| group.options.id == active_group) {
            active_group
        } else {
            groups[0].options.id.clone()
        };
        let running = Running {
            token,
            port,
            addresses,
            ipv6_addresses,
            groups,
            active_group,
            shutdown,
            task: Some(task),
        };
        let status = status_from(&running);
        *self
            .running
            .lock()
            .map_err(|_| "分享状态不可用，请重试".to_string())? = Some(running);
        Ok(status)
    }

    /// 停止监听并返回运行数据，供重启复用。
    async fn take_running(&self) -> Option<Running> {
        let mut running = self
            .running
            .lock()
            .ok()
            .and_then(|mut guard| guard.take())?;
        let _ = running.shutdown.send(true);
        if let Some(mut task) = running.task.take() {
            if tokio::time::timeout(SHUTDOWN_GRACE, &mut task)
                .await
                .is_err()
            {
                task.abort();
            }
        }
        let _ = fs::remove_dir_all(shared_temp_dir(&running.token));
        Some(running)
    }

    pub async fn stop(&self) -> ShareStatus {
        self.take_running().await;
        ShareStatus::default()
    }

    /// 服务运行中向当前分组追加文件或目录；重复路径会被忽略。
    pub fn add_items(&self, paths: Vec<String>) -> Result<ShareStatus, String> {
        let guard = self
            .running
            .lock()
            .map_err(|_| "分享状态不可用，请重试".to_string())?;
        let Some(running) = guard.as_ref() else {
            return Err("分享还没有开始".to_string());
        };
        let group = Self::active_group(running)?;
        let candidates = collect_items(paths)?;
        {
            let mut items = group
                .items
                .write()
                .map_err(|_| "分享列表不可用，请重试".to_string())?;
            if items.len() + candidates.len() > MAX_SHARED_ITEMS {
                return Err(format!("一次最多分享 {MAX_SHARED_ITEMS} 项"));
            }
            let mut changed = false;
            for candidate in candidates {
                if items.iter().any(|item| item.path == candidate.path) {
                    continue;
                }
                let id = group.next_id.fetch_add(1, Ordering::SeqCst);
                items.push(SharedItem { id, ..candidate });
                changed = true;
            }
            if changed {
                let _ = group.events.send(());
            }
        }
        Ok(status_from(running))
    }

    pub fn remove_item(&self, id: u32) -> Result<ShareStatus, String> {
        let guard = self
            .running
            .lock()
            .map_err(|_| "分享状态不可用，请重试".to_string())?;
        let Some(running) = guard.as_ref() else {
            return Err("分享还没有开始".to_string());
        };
        let group = Self::active_group(running)?;
        {
            let mut items = group
                .items
                .write()
                .map_err(|_| "分享列表不可用，请重试".to_string())?;
            let before = items.len();
            items.retain(|item| item.id != id);
            if items.len() != before {
                let _ = group.events.send(());
            }
        }
        Ok(status_from(running))
    }

    /// 关窗或退出时使用：只发信号并中止任务，不阻塞 UI。
    pub fn shutdown_now(&self) {
        if let Some(mut running) = self.running.lock().ok().and_then(|mut guard| guard.take()) {
            let _ = running.shutdown.send(true);
            if let Some(task) = running.task.take() {
                task.abort();
            }
            let _ = fs::remove_dir_all(shared_temp_dir(&running.token));
        }
    }

    pub fn status(&self) -> ShareStatus {
        let guard = match self.running.lock() {
            Ok(guard) => guard,
            Err(_) => return ShareStatus::default(),
        };
        match guard.as_ref() {
            Some(running) => status_from(running),
            None => ShareStatus::default(),
        }
    }
}

fn items_view(items: &[SharedItem]) -> Vec<SharedItemView> {
    items
        .iter()
        .map(|item| SharedItemView {
            id: item.id,
            kind: item.kind,
            name: item.name.clone(),
            size: item.size,
            modified: item.modified,
            text: item.text.clone(),
            visitor: item.visitor,
        })
        .collect()
}

fn status_from(running: &Running) -> ShareStatus {
    let active = running
        .groups
        .iter()
        .find(|group| group.options.id == running.active_group)
        .or_else(|| running.groups.first());
    let groups = running
        .groups
        .iter()
        .map(|group| {
            let items = group
                .items
                .read()
                .map(|guard| guard.clone())
                .unwrap_or_default();
            GroupStatus {
                id: group.options.id.clone(),
                name: group.options.name.clone(),
                slug: group.options.slug.clone(),
                url: group.url.clone(),
                public: group.public,
                protection: group.protection,
                items: items_view(&items),
            }
        })
        .collect();
    let warning = if running.addresses.is_empty() {
        Some("没有检测到局域网地址，目前只能在本机访问".to_string())
    } else if let Some(group) = active {
        if matches!(group.protection, Protection::Link) && !group.public {
            Some(
                "当前分组未开放访问：在设置里开启「允许公开访问」，或改用 PIN/账号保护".to_string(),
            )
        } else {
            None
        }
    } else {
        None
    };
    let (items, url) = match active {
        Some(group) => {
            let items = group
                .items
                .read()
                .map(|guard| guard.clone())
                .unwrap_or_default();
            (items_view(&items), Some(group.url.clone()))
        }
        None => (Vec::new(), None),
    };
    ShareStatus {
        running: true,
        url,
        port: Some(running.port),
        items,
        addresses: running.addresses.clone(),
        ipv6_addresses: running.ipv6_addresses.clone(),
        warning,
        active_group: active
            .map(|group| group.options.id.clone())
            .unwrap_or_default(),
        groups,
    }
}

pub(crate) fn download_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .map(|home| home.join("Downloads"))
        .unwrap_or_else(|| std::env::temp_dir())
}

pub(crate) fn unique_destination(dir: &std::path::Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem.to_string(), format!(".{extension}")),
        _ => (name.to_string(), String::new()),
    };
    for index in 1..1000 {
        let candidate = dir.join(format!("{stem} ({index}){extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{}-{}", random_token(), name))
}

fn build_items_zip(items: &[SharedItem], destination: &std::path::Path) -> Result<(), String> {
    use std::io::Write;
    let file = fs::File::create(destination).map_err(|error| error.to_string())?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    for item in items {
        match item.kind {
            ItemKind::File => {
                writer
                    .start_file(item.name.clone(), options)
                    .map_err(|error| error.to_string())?;
                let mut source = fs::File::open(&item.path).map_err(|error| error.to_string())?;
                std::io::copy(&mut source, &mut writer).map_err(|error| error.to_string())?;
            }
            ItemKind::Dir => {
                let mut stack = vec![(item.path.clone(), item.name.clone())];
                while let Some((dir, prefix)) = stack.pop() {
                    let reader = fs::read_dir(&dir).map_err(|error| error.to_string())?;
                    for entry in reader.flatten() {
                        let path = entry.path();
                        let name = entry.file_name().to_string_lossy().into_owned();
                        let zip_name = format!("{prefix}/{name}");
                        let Ok(file_type) = entry.file_type() else {
                            continue;
                        };
                        if file_type.is_dir() {
                            writer
                                .add_directory(format!("{zip_name}/"), options)
                                .map_err(|error| error.to_string())?;
                            stack.push((path, zip_name));
                        } else if file_type.is_file() {
                            writer
                                .start_file(zip_name, options)
                                .map_err(|error| error.to_string())?;
                            let mut source =
                                fs::File::open(&path).map_err(|error| error.to_string())?;
                            std::io::copy(&mut source, &mut writer)
                                .map_err(|error| error.to_string())?;
                        }
                    }
                }
            }
            ItemKind::Text => {}
        }
    }
    writer.finish().map_err(|error| error.to_string())?;
    Ok(())
}

fn modified_secs(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
}

/// 校验并登记分享项：文件或目录，按真实路径去重。
fn collect_items(paths: Vec<String>) -> Result<Vec<SharedItem>, String> {
    if paths.is_empty() {
        return Err("请先选择要分享的文件或文件夹".to_string());
    }
    if paths.len() > MAX_SHARED_ITEMS {
        return Err(format!("一次最多分享 {MAX_SHARED_ITEMS} 项"));
    }

    let mut seen = HashSet::new();
    let mut items = Vec::with_capacity(paths.len());
    for raw in paths {
        let path = PathBuf::from(&raw);
        let canonical = path
            .canonicalize()
            .map_err(|_| format!("找不到路径：{}", path.display()))?;
        if !seen.insert(canonical.clone()) {
            continue;
        }
        let meta = fs::metadata(&canonical)
            .map_err(|_| format!("无法读取路径：{}", canonical.display()))?;
        let kind = if meta.is_dir() {
            ItemKind::Dir
        } else if meta.is_file() {
            ItemKind::File
        } else {
            return Err(format!("只支持分享文件或文件夹：{}", canonical.display()));
        };
        let name = canonical
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "共享内容".to_string());
        items.push(SharedItem {
            id: items.len() as u32 + 1,
            kind,
            name,
            path: canonical,
            size: if kind == ItemKind::File {
                meta.len()
            } else {
                0
            },
            modified: modified_secs(&meta),
            text: None,
            visitor: false,
        });
    }
    Ok(items)
}

/// 生成 32 位十六进制会话 token。
fn random_token() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        let fallback = format!(
            "{:x}{:x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default()
        );
        return format!("{fallback:0>32}").chars().take(32).collect();
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 端口 0 或默认端口被占用时退回系统分配的临时端口。
fn bind_listener_v6(port: u16) -> Option<TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};
    let socket = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP)).ok()?;
    socket.set_only_v6(true).ok()?;
    socket.set_reuse_address(true).ok()?;
    let address: std::net::SocketAddr = format!("[::]:{port}").parse().ok()?;
    socket.bind(&address.into()).ok()?;
    socket.listen(1024).ok()?;
    socket.set_nonblocking(true).ok()?;
    let std_listener: std::net::TcpListener = socket.into();
    TcpListener::from_std(std_listener).ok()
}

async fn bind_listener(preferred: u16) -> Result<(TcpListener, u16), String> {
    let try_ports: &[u16] = if preferred == 0 {
        &[DEFAULT_PORT, 0]
    } else {
        &[preferred, 0]
    };
    for port in try_ports {
        if let Ok(listener) = TcpListener::bind(("0.0.0.0", *port)).await {
            let bound = listener
                .local_addr()
                .map_err(|error| format!("无法读取分享端口：{error}"))?
                .port();
            return Ok((listener, bound));
        }
    }
    Err("无法启动分享服务，请检查端口或防火墙".to_string())
}

/// 生成可内嵌的 SVG 二维码，前端直接渲染。
pub fn qr_svg(url: &str) -> Result<String, String> {
    let code = qrcode::QrCode::new(url.as_bytes()).map_err(|_| "生成二维码失败".to_string())?;
    let svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(184, 184)
        .quiet_zone(true)
        .build();
    // 只保留 <svg> 片段，避免 XML 声明被 v-html 当成文本节点。
    let start = svg.find("<svg").unwrap_or(0);
    Ok(svg[start..].to_string())
}

#[tauri::command]
pub async fn share_start(
    app: AppHandle,
    manager: tauri::State<'_, ShareManager>,
    settings: tauri::State<'_, SettingsState>,
    paths: Vec<String>,
) -> Result<ShareStatus, String> {
    let options = crate::settings::share_options(&settings.get());
    let status = manager.start(paths, options, Some(app.clone())).await?;
    let _ = app.emit("share-status", status.clone());
    Ok(status)
}

#[tauri::command]
pub async fn share_stop(
    app: AppHandle,
    manager: tauri::State<'_, ShareManager>,
) -> Result<ShareStatus, String> {
    let status = manager.stop().await;
    let _ = app.emit("share-status", status.clone());
    Ok(status)
}

#[tauri::command]
pub fn share_add_items(
    app: AppHandle,
    manager: tauri::State<'_, ShareManager>,
    paths: Vec<String>,
) -> Result<ShareStatus, String> {
    let status = manager.add_items(paths)?;
    let _ = app.emit("share-status", status.clone());
    Ok(status)
}

#[tauri::command]
pub fn share_remove_item(
    app: AppHandle,
    manager: tauri::State<'_, ShareManager>,
    id: u32,
) -> Result<ShareStatus, String> {
    let status = manager.remove_item(id)?;
    let _ = app.emit("share-status", status.clone());
    Ok(status)
}

#[tauri::command]
pub fn share_status(manager: tauri::State<'_, ShareManager>) -> ShareStatus {
    manager.status()
}

#[tauri::command]
pub async fn share_pick_files(app: AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .blocking_pick_files()
            .unwrap_or_default();
        selected
            .into_iter()
            .filter_map(|file| file.into_path().ok())
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|_| "选择文件失败，请重试".to_string())
}

#[tauri::command]
pub async fn share_pick_directory(app: AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(folder) = app.dialog().file().blocking_pick_folder() else {
            return Vec::new();
        };
        folder
            .into_path()
            .map(|path| vec![path.display().to_string()])
            .unwrap_or_default()
    })
    .await
    .map_err(|_| "选择文件夹失败，请重试".to_string())
}

#[tauri::command]
pub fn share_qr_svg(url: String) -> Result<String, String> {
    qr_svg(&url)
}

#[tauri::command]
pub fn share_open_upload_dir(manager: tauri::State<'_, ShareManager>) -> Result<(), String> {
    let dir = manager.active_upload_dir()?;
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|_| "无法打开接收目录".to_string())
}

#[tauri::command]
pub async fn share_save_items(
    app: AppHandle,
    manager: tauri::State<'_, ShareManager>,
    ids: Vec<u32>,
) -> Result<bool, String> {
    let items = manager.snapshot_items(&ids)?;
    let single_file = items.len() == 1 && items[0].kind == ItemKind::File;
    let default_name = if single_file {
        items[0].name.clone()
    } else {
        "共享内容.zip".to_string()
    };
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file().set_directory(download_dir());
        let dialog = if single_file {
            dialog.set_file_name(&default_name)
        } else {
            dialog
                .set_file_name(&default_name)
                .add_filter("ZIP", &["zip"])
        };
        let Some(selected) = dialog.blocking_save_file() else {
            return Ok(false);
        };
        let destination = selected
            .into_path()
            .map_err(|_| "保存位置无效".to_string())?;
        if single_file {
            fs::copy(&items[0].path, &destination).map_err(|_| "保存文件失败".to_string())?;
        } else {
            build_items_zip(&items, &destination)?;
        }
        Ok(true)
    })
    .await
    .map_err(|_| "保存失败，请重试".to_string())?
}

#[tauri::command]
pub fn share_set_active_group(
    app: AppHandle,
    manager: tauri::State<'_, ShareManager>,
    group_id: String,
) -> Result<ShareStatus, String> {
    let status = manager.set_active_group(group_id)?;
    let _ = app.emit("share-status", status.clone());
    Ok(status)
}

#[tauri::command]
pub fn share_add_text(
    app: AppHandle,
    manager: tauri::State<'_, ShareManager>,
    text: String,
) -> Result<(), String> {
    manager.add_text(text)?;
    let _ = app.emit("share-refresh", ());
    Ok(())
}

#[tauri::command]
pub fn share_set_title(app: AppHandle, title: String) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "窗口不可用".to_string())?;
    window
        .set_title(&title)
        .map_err(|_| "设置窗口标题失败".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("tinypng-share-test-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    fn temp_file(name: &str, bytes: &[u8]) -> PathBuf {
        let path = temp_dir(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn temp_folder(name: &str) -> PathBuf {
        let path = temp_dir(name);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn options() -> ShareOptions {
        let upload_dir = std::env::temp_dir().join("tinypng-share-test-uploads");
        ShareOptions {
            port: 0,
            protection: Protection::Link,
            public: true,
            pin_hash: None,
            allow_upload: false,
            allow_text: false,
            auto_save_uploads: false,
            accounts: Vec::new(),
            groups: vec![GroupOptions {
                id: "default".to_string(),
                name: "默认分组".to_string(),
                slug: String::new(),
                upload_dir: upload_dir.clone(),
                public: true,
                protection: Protection::Link,
                pin_hash: None,
                allow_upload: false,
                allow_text: false,
            }],
            upload_dir,
            language: Language::Auto,
        }
    }

    #[tokio::test]
    async fn token_is_32_hex_chars() {
        let token = random_token();
        assert_eq!(token.len(), 32);
        assert!(token.chars().all(|value| value.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn collects_files_and_folders() {
        assert!(collect_items(vec![]).is_err());
        assert!(collect_items(vec!["/definitely/missing/path".into()]).is_err());

        let file = temp_file("one.txt", b"one");
        let folder = temp_folder("folder");
        let items = collect_items(vec![
            file.display().to_string(),
            folder.display().to_string(),
            file.display().to_string(),
        ])
        .unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].kind, ItemKind::File);
        assert_eq!(items[1].kind, ItemKind::Dir);
    }

    #[tokio::test]
    async fn manager_adds_text_live() {
        let file = temp_file("live-text.txt", b"x");
        let manager = ShareManager::default();
        manager
            .start(vec![file.display().to_string()], options(), None)
            .await
            .unwrap();
        manager.add_text("hello from manager".to_string()).unwrap();
        let status = manager.status();
        assert!(status
            .items
            .iter()
            .any(|item| item.name == "hello from manager"));
        manager.stop().await;
    }

    #[tokio::test]
    async fn groups_isolate_items_and_serve_subpaths() {
        let first = temp_file("group-a.txt", b"a");
        let second = temp_file("group-b.txt", b"b");
        let mut settings = options();
        settings.groups.push(GroupOptions {
            id: "team".to_string(),
            name: "Team".to_string(),
            slug: "team-a".to_string(),
            upload_dir: std::env::temp_dir().join("tinypng-share-test-team"),
            public: true,
            protection: Protection::Link,
            pin_hash: None,
            allow_upload: false,
            allow_text: false,
        });
        let manager = ShareManager::default();
        manager
            .start(vec![first.display().to_string()], settings, None)
            .await
            .unwrap();
        manager.set_active_group("team".to_string()).unwrap();
        manager
            .add_items(vec![second.display().to_string()])
            .unwrap();
        manager.set_active_group("default".to_string()).unwrap();

        let status = manager.status();
        assert_eq!(status.groups.len(), 2);
        let root_url = status.url.clone().unwrap();
        let team_url = status
            .groups
            .iter()
            .find(|group| group.slug == "team-a")
            .map(|group| group.url.clone())
            .unwrap();

        let client = reqwest::Client::new();
        let page = client.get(team_url.clone()).send().await.unwrap();
        assert!(
            page.status().is_success() || page.status().is_redirection(),
            "分组页面不可访问：{}",
            page.status()
        );
        let root_items: Vec<serde_json::Value> = client
            .get(format!("{root_url}/api/items"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let team_items: Vec<serde_json::Value> = client
            .get(format!("{team_url}/api/items"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(root_items.iter().any(|item| item["name"] == "group-a.txt"));
        assert!(!root_items.iter().any(|item| item["name"] == "group-b.txt"));
        assert!(team_items.iter().any(|item| item["name"] == "group-b.txt"));
        assert!(!team_items.iter().any(|item| item["name"] == "group-a.txt"));
        manager.stop().await;
    }

    #[tokio::test]
    async fn group_pin_is_scoped_to_that_group() {
        let file = temp_file("group-pin.txt", b"pin");
        let mut settings = options();
        settings.groups.push(GroupOptions {
            id: "team".to_string(),
            name: "Team".to_string(),
            slug: "team-pin".to_string(),
            upload_dir: std::env::temp_dir().join("tinypng-share-test-team-pin"),
            public: false,
            protection: Protection::Pin,
            pin_hash: Some(auth::hash_secret("246810").unwrap()),
            allow_upload: false,
            allow_text: false,
        });
        let manager = ShareManager::default();
        manager
            .start(vec![file.display().to_string()], settings, None)
            .await
            .unwrap();
        let status = manager.status();
        let root_url = status.url.clone().unwrap();
        let team_url = status
            .groups
            .iter()
            .find(|group| group.slug == "team-pin")
            .map(|group| group.url.clone())
            .unwrap();
        let client = reqwest::Client::new();
        assert_eq!(
            client
                .get(format!("{root_url}/api/items"))
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::OK
        );
        assert_eq!(
            client
                .get(format!("{team_url}/api/items"))
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::UNAUTHORIZED
        );
        let unlock = client
            .post(format!("{team_url}/api/unlock"))
            .header("x-share-csrf", "1")
            .json(&serde_json::json!({ "pin": "246810" }))
            .send()
            .await
            .unwrap();
        assert_eq!(unlock.status(), reqwest::StatusCode::OK);
        let cookie = unlock
            .headers()
            .get(reqwest::header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(cookie.contains("Path=/g/team-pin"), "{cookie}");
        let cookie = cookie.split(';').next().unwrap().to_string();
        assert_eq!(
            client
                .get(format!("{team_url}/api/items"))
                .header(reqwest::header::COOKIE, cookie)
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::OK
        );
        manager.stop().await;
    }

    #[test]
    fn selected_items_zip_contains_files_and_folders() {
        let root = temp_folder("zip-selection");
        let folder = root.join("album");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("a.txt"), b"a").unwrap();
        let single = root.join("single.txt");
        fs::write(&single, b"single").unwrap();
        let items = vec![
            SharedItem {
                id: 1,
                kind: ItemKind::File,
                name: "single.txt".to_string(),
                path: single.clone(),
                size: 6,
                modified: None,
                text: None,
                visitor: false,
            },
            SharedItem {
                id: 2,
                kind: ItemKind::Dir,
                name: "album".to_string(),
                path: folder.clone(),
                size: 0,
                modified: None,
                text: None,
                visitor: false,
            },
        ];
        let zip_path = root.join("selection.zip");
        build_items_zip(&items, &zip_path).unwrap();
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
        assert!(names.contains("single.txt"));
        assert!(names.contains("album/a.txt"));
    }

    #[test]
    fn qr_svg_is_self_contained() {
        let svg = qr_svg("http://192.168.1.5:5421/s/abc").unwrap();
        assert!(svg.trim_start().starts_with("<svg"));
        assert!(svg.contains("</svg>"));
    }

    #[tokio::test]
    async fn manager_lifecycle_serves_adds_and_stops() {
        let first = temp_file("life-a.txt", b"hello");
        let folder = temp_folder("life-folder");
        fs::write(folder.join("inside.txt"), b"inside").unwrap();
        let manager = ShareManager::default();

        let status = manager
            .start(vec![first.display().to_string()], options(), None)
            .await
            .unwrap();
        assert!(status.running);
        assert!(!status.url.as_deref().unwrap_or_default().contains("/s/"));
        let port = status.port.unwrap();
        let local = format!("http://127.0.0.1:{port}");

        let client = reqwest::Client::new();
        let listed: Vec<serde_json::Value> = client
            .get(format!("{local}/api/items"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);

        let added = manager
            .add_items(vec![folder.display().to_string()])
            .unwrap();
        assert_eq!(added.items.len(), 2);

        let removed = manager.remove_item(added.items[0].id).unwrap();
        assert_eq!(removed.items.len(), 1);

        let restarted = manager.restart(options(), None).await.unwrap();
        assert_eq!(restarted.items.len(), 1);

        let stopped = manager.stop().await;
        assert!(!stopped.running);
    }

    #[tokio::test]
    async fn lists_and_serves_file_with_range() {
        let path = temp_file("测试 图片.png", b"0123456789abcdef");
        let items = collect_items(vec![path.display().to_string()]).unwrap();
        let (base, _token, _items) = server_tests::spawn(items).await;

        let client = reqwest::Client::new();
        let list: serde_json::Value = client
            .get(format!("{base}/api/items"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["name"], "测试 图片.png");
        assert_eq!(list[0]["kind"], "file");

        let file_url = format!("{base}/api/download?id={}", list[0]["id"]);
        let full = client.get(&file_url).send().await.unwrap();
        assert_eq!(full.status(), reqwest::StatusCode::OK);
        let disposition = full
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(
            disposition.contains("filename*=UTF-8''%E6%B5%8B%E8%AF%95%20%E5%9B%BE%E7%89%87.png")
        );
        assert_eq!(full.bytes().await.unwrap().as_ref(), b"0123456789abcdef");

        let ranged = client
            .get(&file_url)
            .header(reqwest::header::RANGE, "bytes=4-7")
            .send()
            .await
            .unwrap();
        assert_eq!(ranged.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        assert_eq!(ranged.bytes().await.unwrap().as_ref(), b"4567");
    }

    #[tokio::test]
    async fn live_list_reflects_added_items() {
        let first = temp_file("first.txt", b"one");
        let second = temp_file("second.txt", b"two");
        let items = collect_items(vec![first.display().to_string()]).unwrap();
        let (base, _token, shared) = server_tests::spawn(items).await;
        let client = reqwest::Client::new();

        let before: Vec<serde_json::Value> = client
            .get(format!("{base}/api/items"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(before.len(), 1);

        {
            let mut guard = shared.write().unwrap();
            guard.push(SharedItem {
                id: 2,
                kind: ItemKind::File,
                name: "second.txt".to_string(),
                path: second,
                size: 3,
                modified: None,
                text: None,
                visitor: false,
            });
        }

        let after: Vec<serde_json::Value> = client
            .get(format!("{base}/api/items"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(after.len(), 2);
    }

    #[tokio::test]
    async fn serves_directory_listing_zip_and_thumbnails() {
        let folder = temp_folder("listing");
        fs::create_dir_all(folder.join("sub")).unwrap();
        fs::write(folder.join("notes.txt"), b"hi").unwrap();
        fs::write(folder.join("sub/inner.txt"), b"inner").unwrap();
        image::RgbImage::new(8, 8)
            .save(folder.join("photo.png"))
            .unwrap();

        let items = collect_items(vec![folder.display().to_string()]).unwrap();
        let (base, _token, _items) = server_tests::spawn(items).await;
        let client = reqwest::Client::new();

        let listing: serde_json::Value = client
            .get(format!("{base}/api/list?id=1&path="))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let entries = listing["entries"].as_array().unwrap();
        assert!(entries
            .iter()
            .any(|entry| entry["name"] == "sub" && entry["kind"] == "dir"));
        assert!(entries
            .iter()
            .any(|entry| entry["name"] == "photo.png" && entry["thumb"] == true));

        let nested: serde_json::Value = client
            .get(format!("{base}/api/list?id=1&path=sub"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(nested["path"], serde_json::json!(["sub"]));
        assert_eq!(nested["entries"].as_array().unwrap().len(), 1);

        let zip = client
            .get(format!("{base}/api/download?id=1&path="))
            .send()
            .await
            .unwrap();
        assert_eq!(zip.status(), reqwest::StatusCode::OK);
        assert!(zip.bytes().await.unwrap().starts_with(b"PK"));

        let thumb = client
            .get(format!("{base}/api/thumb?id=1&path=photo.png"))
            .send()
            .await
            .unwrap();
        assert_eq!(thumb.status(), reqwest::StatusCode::OK);
        assert_eq!(
            thumb.headers().get(reqwest::header::CONTENT_TYPE).unwrap(),
            "image/jpeg"
        );

        let traversal = client
            .get(format!("{base}/api/list?id=1&path=..%2F"))
            .send()
            .await
            .unwrap();
        assert_eq!(traversal.status(), reqwest::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn root_page_and_assets_are_tokenless() {
        let file = temp_file("root.txt", b"root");
        let items = collect_items(vec![file.display().to_string()]).unwrap();
        let (base, _token, _items) = server_tests::spawn(items).await;
        let client = reqwest::Client::new();

        let page = client.get(format!("{base}/")).send().await.unwrap();
        assert_eq!(page.status(), reqwest::StatusCode::OK);
        let html = page.text().await.unwrap();
        assert!(html.contains("/assets/app.css"));
        assert!(!html.contains("/s/"));

        assert_eq!(
            client
                .get(format!("{base}/assets/app.js"))
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::OK
        );

        let state: serde_json::Value = client
            .get(format!("{base}/api/state"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(state["public"], true);
        assert_eq!(state["protection"], "link");
    }

    #[tokio::test]
    async fn pin_protection_requires_unlock_cookie() {
        let file = temp_file("pin.txt", b"pin");
        let items = collect_items(vec![file.display().to_string()]).unwrap();
        let mut options = options();
        options.protection = Protection::Pin;
        options.pin_hash = Some(auth::hash_secret("123456").unwrap());
        let (base, _token, _items) = server_tests::spawn_with(items, options).await;

        let client = reqwest::Client::new();
        assert_eq!(
            client
                .get(format!("{base}/api/items"))
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::UNAUTHORIZED
        );

        let wrong = client
            .post(format!("{base}/api/unlock"))
            .header("x-share-csrf", "1")
            .json(&serde_json::json!({ "pin": "000000" }))
            .send()
            .await
            .unwrap();
        assert_eq!(wrong.status(), reqwest::StatusCode::UNAUTHORIZED);

        let ok = client
            .post(format!("{base}/api/unlock"))
            .header("x-share-csrf", "1")
            .json(&serde_json::json!({ "pin": "123456" }))
            .send()
            .await
            .unwrap();
        assert_eq!(ok.status(), reqwest::StatusCode::OK);
        let cookie = ok
            .headers()
            .get(reqwest::header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();

        assert_eq!(
            client
                .get(format!("{base}/api/items"))
                .header(reqwest::header::COOKIE, cookie)
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::OK
        );
    }

    #[tokio::test]
    async fn account_login_controls_permissions() {
        let file = temp_file("account.txt", b"account");
        let items = collect_items(vec![file.display().to_string()]).unwrap();
        let mut options = options();
        options.protection = Protection::Accounts;
        options.accounts = vec![Account {
            id: "a1".to_string(),
            username: "alice".to_string(),
            password: "pass1234".to_string(),
            permissions: auth::Permissions {
                download: true,
                upload: false,
                text: false,
            },
            enabled: true,
        }];
        let (base, _token, _items) = server_tests::spawn_with(items, options).await;

        let client = reqwest::Client::new();
        let login = client
            .post(format!("{base}/api/login"))
            .header("x-share-csrf", "1")
            .json(&serde_json::json!({ "username": "alice", "password": "pass1234" }))
            .send()
            .await
            .unwrap();
        assert_eq!(login.status(), reqwest::StatusCode::OK);
        let cookie = login
            .headers()
            .get(reqwest::header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();

        assert_eq!(
            client
                .get(format!("{base}/api/items"))
                .header(reqwest::header::COOKIE, &cookie)
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::OK
        );
        assert_eq!(
            client
                .post(format!("{base}/api/upload"))
                .header(reqwest::header::COOKIE, &cookie)
                .header("x-share-csrf", "1")
                .multipart(reqwest::multipart::Form::new())
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn link_mode_accepts_text_and_uploads_when_enabled() {
        let file = temp_file("link.txt", b"link");
        let items = collect_items(vec![file.display().to_string()]).unwrap();
        let upload_dir = temp_folder("upload-target");
        let mut options = options();
        options.allow_upload = true;
        options.allow_text = true;
        options.upload_dir = upload_dir.clone();
        let (base, _token, _items) = server_tests::spawn_with(items, options).await;

        let client = reqwest::Client::new();
        let text = client
            .post(format!("{base}/api/text"))
            .header("x-share-csrf", "1")
            .json(&serde_json::json!({ "text": "hello from visitor" }))
            .send()
            .await
            .unwrap();
        assert_eq!(text.status(), reqwest::StatusCode::OK);

        let form = reqwest::multipart::Form::new().part(
            "file",
            reqwest::multipart::Part::bytes(b"uploaded".to_vec()).file_name("evil/../报告.txt"),
        );
        let upload = client
            .post(format!("{base}/api/upload"))
            .header("x-share-csrf", "1")
            .multipart(form)
            .send()
            .await
            .unwrap();
        assert_eq!(upload.status(), reqwest::StatusCode::OK);

        let listed: Vec<serde_json::Value> = client
            .get(format!("{base}/api/items"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(listed.iter().any(|item| item["kind"] == "text"));
        assert!(listed
            .iter()
            .any(|item| item["name"] == "报告.txt" && item["visitor"] == true));
        assert!(upload_dir.join("报告.txt").exists());
        assert!(!upload_dir.join("evil").exists());
    }

    #[tokio::test]
    async fn rejects_old_token_paths_and_foreign_host() {
        let path = temp_file("a.txt", b"hello");
        let items = collect_items(vec![path.display().to_string()]).unwrap();
        let (base, _token, _items) = server_tests::spawn(items).await;

        let client = reqwest::Client::new();
        assert_eq!(
            client
                .get(format!("{base}/s/deadbeef/api/items"))
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::NOT_FOUND
        );

        let foreign = client
            .get(format!("{base}/api/items"))
            .header(reqwest::header::HOST, "evil.example.com")
            .send()
            .await
            .unwrap();
        assert_eq!(foreign.status(), reqwest::StatusCode::FORBIDDEN);
    }

    /// 在 127.0.0.1 的随机端口启动同一套路由，供测试复用。
    mod server_tests {
        use std::sync::atomic::AtomicU32;
        use std::sync::{Arc, RwLock};

        use tokio::net::TcpListener;
        use tokio::sync::broadcast;

        use super::super::auth::AuthConfig;
        use super::super::server;
        use super::super::{Language, ShareOptions, SharedItem};
        use super::options;

        pub async fn spawn(
            items: Vec<SharedItem>,
        ) -> (String, String, Arc<RwLock<Vec<SharedItem>>>) {
            spawn_with(items, options()).await
        }

        pub async fn spawn_with(
            items: Vec<SharedItem>,
            options: ShareOptions,
        ) -> (String, String, Arc<RwLock<Vec<SharedItem>>>) {
            let token = "test-token".to_string();
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let shared = Arc::new(RwLock::new(items));
            let (events, _) = broadcast::channel(16);
            let auth = Arc::new(AuthConfig::new(
                options.protection,
                options.public,
                options.pin_hash.clone(),
                options.accounts.clone(),
                options.allow_upload,
                options.allow_text,
            ));
            let next_id = Arc::new(AtomicU32::new(100));
            let context = server::Context {
                base: String::new(),
                cookie_path: "/".to_string(),
                items: shared.clone(),
                port,
                events,
                zip_dir: std::env::temp_dir().join("tinypng-share-test-zips"),
                auth,
                next_id,
                upload_dir: options.upload_dir.clone(),
                language: Arc::new(RwLock::new(Language::Auto)),
                public: true,
                auto_save_uploads: false,
                app: None,
            };
            let app = server::router(vec![context]);
            tokio::spawn(async move {
                let _ = axum::serve(
                    listener,
                    app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
                )
                .await;
            });
            (format!("http://127.0.0.1:{port}"), token, shared)
        }
    }
}
