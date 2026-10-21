//! 局域网分享面：进程内 HTTP 服务、分享列表与生命周期。
//!
//! 参考 file-share 的能力形状，服务端用 axum 重写；压缩链路保持原样。

mod net;
mod server;

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::net::TcpListener;
use tokio::sync::watch;

const DEFAULT_PORT: u16 = 5421;
const MAX_SHARED_FILES: usize = 200;
/// 停止服务时等待在途下载的时间。
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// 分享中的一个文件。真实路径只留在 Rust 侧。
#[derive(Clone)]
pub struct SharedFile {
    pub id: u32,
    pub name: String,
    pub path: PathBuf,
    pub size: u64,
}

/// 下发给前端的文件描述，不含本机路径。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedFileView {
    pub id: u32,
    pub name: String,
    pub size: u64,
    pub url: String,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShareStatus {
    pub running: bool,
    pub url: Option<String>,
    pub port: Option<u16>,
    pub files: Vec<SharedFileView>,
    /// 所有候选局域网地址，前端用于切换网卡。
    pub addresses: Vec<String>,
    pub warning: Option<String>,
}

struct Running {
    url: String,
    port: u16,
    /// 访客文件路径前缀，形如 `/s/<token>`。
    path_base: String,
    files: Arc<RwLock<Vec<SharedFile>>>,
    next_id: AtomicU32,
    addresses: Vec<String>,
    shutdown: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
pub struct ShareManager {
    running: Mutex<Option<Running>>,
}

impl ShareManager {
    pub async fn start(&self, paths: Vec<String>) -> Result<ShareStatus, String> {
        let files = collect_files(paths)?;
        // 先停掉旧会话，复用同一端口与列表语义。
        let _ = self.stop().await;

        let token = random_token();
        let (listener, port) = bind_listener().await?;
        let addresses = net::candidate_addresses();
        let primary = addresses
            .first()
            .cloned()
            .unwrap_or_else(|| "127.0.0.1".to_string());
        let path_base = format!("/s/{token}");
        let url = format!("http://{primary}:{port}{path_base}");

        let next_id = files.iter().map(|file| file.id).max().unwrap_or(0) + 1;
        let files = Arc::new(RwLock::new(files));
        let context = server::Context {
            token: Arc::new(token),
            files: files.clone(),
            port,
        };
        let app = server::router(context);

        let (shutdown, mut rx) = watch::channel(false);
        let task = tokio::spawn(async move {
            let served = axum::serve(listener, app).with_graceful_shutdown(async move {
                let _ = rx.changed().await;
            });
            let _ = served.await;
        });

        let running = Running {
            url,
            port,
            path_base,
            files,
            next_id: AtomicU32::new(next_id),
            addresses,
            shutdown,
            task,
        };
        let status = status_from(&running);
        *self
            .running
            .lock()
            .map_err(|_| "分享状态不可用，请重试".to_string())? = Some(running);
        Ok(status)
    }

    pub async fn stop(&self) -> ShareStatus {
        let running = self.running.lock().ok().and_then(|mut guard| guard.take());
        if let Some(running) = running {
            let _ = running.shutdown.send(true);
            let mut task = running.task;
            if tokio::time::timeout(SHUTDOWN_GRACE, &mut task)
                .await
                .is_err()
            {
                task.abort();
            }
        }
        ShareStatus::default()
    }

    /// 服务运行中追加文件；重复路径会被忽略。
    pub fn add_files(&self, paths: Vec<String>) -> Result<ShareStatus, String> {
        let guard = self
            .running
            .lock()
            .map_err(|_| "分享状态不可用，请重试".to_string())?;
        let Some(running) = guard.as_ref() else {
            return Err("分享还没有开始".to_string());
        };

        let candidates = collect_files(paths)?;
        {
            let mut files = running
                .files
                .write()
                .map_err(|_| "分享列表不可用，请重试".to_string())?;
            if files.len() + candidates.len() > MAX_SHARED_FILES {
                return Err(format!("一次最多分享 {MAX_SHARED_FILES} 个文件"));
            }
            for candidate in candidates {
                if files.iter().any(|file| file.path == candidate.path) {
                    continue;
                }
                let id = running.next_id.fetch_add(1, Ordering::SeqCst);
                files.push(SharedFile {
                    id,
                    name: candidate.name,
                    path: candidate.path,
                    size: candidate.size,
                });
            }
        }
        Ok(status_from(running))
    }

    pub fn remove_file(&self, id: u32) -> Result<ShareStatus, String> {
        let guard = self
            .running
            .lock()
            .map_err(|_| "分享状态不可用，请重试".to_string())?;
        let Some(running) = guard.as_ref() else {
            return Err("分享还没有开始".to_string());
        };
        {
            let mut files = running
                .files
                .write()
                .map_err(|_| "分享列表不可用，请重试".to_string())?;
            files.retain(|file| file.id != id);
        }
        Ok(status_from(running))
    }

    /// 关窗或退出时使用：只发信号并中止任务，不阻塞 UI。
    pub fn shutdown_now(&self) {
        if let Some(running) = self.running.lock().ok().and_then(|mut guard| guard.take()) {
            let _ = running.shutdown.send(true);
            running.task.abort();
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

fn status_from(running: &Running) -> ShareStatus {
    let files = running
        .files
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    ShareStatus {
        running: true,
        url: Some(running.url.clone()),
        port: Some(running.port),
        files: files
            .iter()
            .map(|file| SharedFileView {
                id: file.id,
                name: file.name.clone(),
                size: file.size,
                url: format!("{}/f/{}", running.path_base, file.id),
            })
            .collect(),
        addresses: running.addresses.clone(),
        warning: warning_for(&running.addresses),
    }
}

fn warning_for(addresses: &[String]) -> Option<String> {
    if addresses.is_empty() {
        Some("没有检测到局域网地址，目前只能在本机访问".to_string())
    } else {
        None
    }
}

/// 校验并登记分享文件：必须是存在的普通文件，按真实路径去重。
fn collect_files(paths: Vec<String>) -> Result<Vec<SharedFile>, String> {
    if paths.is_empty() {
        return Err("请先选择要分享的文件".to_string());
    }
    if paths.len() > MAX_SHARED_FILES {
        return Err(format!("一次最多分享 {MAX_SHARED_FILES} 个文件"));
    }

    let mut seen = HashSet::new();
    let mut files = Vec::with_capacity(paths.len());
    for raw in paths {
        let path = PathBuf::from(&raw);
        let canonical = path
            .canonicalize()
            .map_err(|_| format!("找不到文件：{}", path.display()))?;
        if !seen.insert(canonical.clone()) {
            continue;
        }
        let meta = fs::metadata(&canonical)
            .map_err(|_| format!("无法读取文件：{}", canonical.display()))?;
        if !meta.is_file() {
            return Err(format!("暂只支持分享文件：{}", canonical.display()));
        }
        if meta.len() == 0 {
            return Err(format!("文件是空的，暂时无法分享：{}", canonical.display()));
        }
        let name = canonical
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "文件".to_string());
        files.push(SharedFile {
            id: files.len() as u32 + 1,
            name,
            path: canonical,
            size: meta.len(),
        });
    }
    Ok(files)
}

/// 生成 32 位十六进制会话 token。
fn random_token() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // 极端情况下退化为时间 + 进程号，仍然保证长度一致。
        let fallback = format!(
            "{:x}{:x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default()
        );
        return format!("{fallback:0>32}").chars().take(32).collect();
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 优先占用 5421，被占用时退回系统分配的临时端口。
async fn bind_listener() -> Result<(TcpListener, u16), String> {
    let listener = match TcpListener::bind(("0.0.0.0", DEFAULT_PORT)).await {
        Ok(listener) => listener,
        Err(_) => TcpListener::bind(("0.0.0.0", 0))
            .await
            .map_err(|error| format!("无法启动分享服务：{error}"))?,
    };
    let port = listener
        .local_addr()
        .map_err(|error| format!("无法读取分享端口：{error}"))?
        .port();
    Ok((listener, port))
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
    paths: Vec<String>,
) -> Result<ShareStatus, String> {
    let status = manager.start(paths).await?;
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
pub fn share_add_files(
    app: AppHandle,
    manager: tauri::State<'_, ShareManager>,
    paths: Vec<String>,
) -> Result<ShareStatus, String> {
    let status = manager.add_files(paths)?;
    let _ = app.emit("share-status", status.clone());
    Ok(status)
}

#[tauri::command]
pub fn share_remove_file(
    app: AppHandle,
    manager: tauri::State<'_, ShareManager>,
    id: u32,
) -> Result<ShareStatus, String> {
    let status = manager.remove_file(id)?;
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
pub fn share_qr_svg(url: String) -> Result<String, String> {
    qr_svg(&url)
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

    fn temp_file(name: &str, bytes: &[u8]) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("tinypng-share-test-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    #[tokio::test]
    async fn token_is_32_hex_chars() {
        let token = random_token();
        assert_eq!(token.len(), 32);
        assert!(token.chars().all(|value| value.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn rejects_missing_and_empty_files() {
        assert!(collect_files(vec![]).is_err());
        let path = temp_file("empty.png", b"");
        assert!(collect_files(vec![path.display().to_string()]).is_err());
    }

    #[test]
    fn qr_svg_is_self_contained() {
        let svg = qr_svg("http://192.168.1.5:5421/s/abc").unwrap();
        assert!(
            svg.trim_start().starts_with("<svg"),
            "二维码应为纯 SVG 片段"
        );
        assert!(svg.contains("</svg>"));
    }

    #[tokio::test]
    async fn lists_and_serves_file_with_range() {
        let path = temp_file("测试 图片.png", b"0123456789abcdef");
        let files = collect_files(vec![path.display().to_string()]).unwrap();
        let (base, _token, _shared) = server_tests::spawn(files).await;
        let origin = base.split("/s/").next().unwrap_or_default().to_string();

        let client = reqwest::Client::new();
        let list: serde_json::Value = client
            .get(format!("{base}/api/files"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["name"], "测试 图片.png");

        let file_url = format!("{origin}{}", list[0]["url"].as_str().unwrap());
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
    async fn live_list_reflects_added_files() {
        let first = temp_file("first.txt", b"one");
        let second = temp_file("second.txt", b"two");
        let files = collect_files(vec![first.display().to_string()]).unwrap();
        let (base, _token, shared) = server_tests::spawn(files).await;
        let client = reqwest::Client::new();

        let before: Vec<serde_json::Value> = client
            .get(format!("{base}/api/files"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(before.len(), 1);

        // 运行中追加文件后，访客列表应立即看到新条目。
        {
            let mut guard = shared.write().unwrap();
            guard.push(SharedFile {
                id: 2,
                name: "second.txt".to_string(),
                path: second,
                size: 3,
            });
        }

        let after: Vec<serde_json::Value> = client
            .get(format!("{base}/api/files"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(after.len(), 2);
        assert_eq!(after[1]["name"], "second.txt");
    }

    #[tokio::test]
    async fn manager_lifecycle_serves_adds_and_stops() {
        let first = temp_file("life-a.txt", b"hello");
        let second = temp_file("life-b.txt", b"world");
        let manager = ShareManager::default();

        let status = manager
            .start(vec![first.display().to_string()])
            .await
            .unwrap();
        assert!(status.running);
        let url = status.url.clone().unwrap();
        let token = url.rsplit('/').next().unwrap().to_string();
        let port = status.port.unwrap();
        let local = format!("http://127.0.0.1:{port}/s/{token}");

        let client = reqwest::Client::new();
        let listed: Vec<serde_json::Value> = client
            .get(format!("{local}/api/files"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);

        let added = manager
            .add_files(vec![second.display().to_string()])
            .unwrap();
        assert_eq!(added.files.len(), 2);

        let removed = manager.remove_file(added.files[0].id).unwrap();
        assert_eq!(removed.files.len(), 1);

        let stopped = manager.stop().await;
        assert!(!stopped.running);
        assert!(manager.status().files.is_empty());

        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        assert!(client
            .get(format!("{local}/api/files"))
            .send()
            .await
            .is_err());
    }

    #[tokio::test]
    async fn rejects_wrong_token_and_foreign_host() {
        let path = temp_file("a.txt", b"hello");
        let files = collect_files(vec![path.display().to_string()]).unwrap();
        let (base, token, _shared) = server_tests::spawn(files).await;

        let client = reqwest::Client::new();
        let wrong = base.replace(&token, "deadbeef");
        assert_eq!(
            client
                .get(format!("{wrong}/api/files"))
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::NOT_FOUND
        );

        let foreign = client
            .get(format!("{base}/api/files"))
            .header(reqwest::header::HOST, "evil.example.com")
            .send()
            .await
            .unwrap();
        assert_eq!(foreign.status(), reqwest::StatusCode::FORBIDDEN);
    }

    /// 在 127.0.0.1 的随机端口启动同一套路由，供测试复用。
    mod server_tests {
        use std::sync::{Arc, RwLock};

        use tokio::net::TcpListener;

        use super::super::server;
        use super::super::SharedFile;

        pub async fn spawn(
            files: Vec<SharedFile>,
        ) -> (String, String, Arc<RwLock<Vec<SharedFile>>>) {
            let token = "test-token".to_string();
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let shared = Arc::new(RwLock::new(files));
            let context = server::Context {
                token: Arc::new(token.clone()),
                files: shared.clone(),
                port,
            };
            let app = server::router(context);
            tokio::spawn(async move {
                let _ = axum::serve(listener, app).await;
            });
            (format!("http://127.0.0.1:{port}/s/{token}"), token, shared)
        }
    }
}
