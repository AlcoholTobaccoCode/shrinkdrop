use crate::file_ops::{self, FileState};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{watch, OwnedSemaphorePermit, Semaphore};

pub const MAX_IMAGE_BYTES: usize = 20_000_000;
const MAX_IMAGE_PIXELS: u64 = 64_000_000;
const SITES: &[&str] = &["tinypng.com", "tinyjpg.com", "tinify.cn"];
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CANCELED: &str = "任务已取消";

//#region 任务注册、并发限制与取消
#[derive(Default)]
struct Registry {
    tasks: HashMap<String, Task>,
    closed_sessions: HashSet<String>,
    closed: bool,
}
struct Task {
    cancel: watch::Sender<bool>,
    registered: bool,
}

pub struct CompressionState {
    registry: Mutex<Registry>,
    slots: Arc<Semaphore>,
}
impl Default for CompressionState {
    fn default() -> Self {
        Self {
            registry: Mutex::new(Registry::default()),
            slots: Arc::new(Semaphore::new(5)),
        }
    }
}
impl CompressionState {
    fn register(&self, id: &str) -> Result<watch::Receiver<bool>, String> {
        validate_task_id(id)?;
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| "任务状态不可用".to_string())?;
        if registry.closed
            || registry
                .closed_sessions
                .iter()
                .any(|session| id.starts_with(&format!("{session}-")))
        {
            return Err(CANCELED.into());
        }
        let task = registry.tasks.entry(id.into()).or_insert_with(|| Task {
            cancel: watch::channel(false).0,
            registered: false,
        });
        if *task.cancel.borrow() {
            return Err(CANCELED.into());
        }
        if task.registered {
            return Err("任务已经提交，请等待结果或重试".into());
        }
        task.registered = true;
        Ok(task.cancel.subscribe())
    }
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        validate_task_id(id)?;
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| "任务状态不可用".to_string())?;
        let task = registry.tasks.entry(id.into()).or_insert_with(|| Task {
            cancel: watch::channel(false).0,
            registered: false,
        });
        task.cancel.send_replace(true);
        Ok(())
    }
    pub fn cancel_session(&self, session: &str) -> Result<(), String> {
        validate_task_id(session)?;
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| "任务状态不可用".to_string())?;
        registry.closed_sessions.insert(session.into());
        for (id, task) in &registry.tasks {
            if id.starts_with(&format!("{session}-")) {
                task.cancel.send_replace(true);
            }
        }
        Ok(())
    }
    pub fn cancel_all(&self) {
        if let Ok(mut registry) = self.registry.lock() {
            registry.closed = true;
            for task in registry.tasks.values() {
                task.cancel.send_replace(true);
            }
        }
    }
    // 保存结果与取消共用注册锁，提前到达的取消不能被迟到结果覆盖。
    fn finalize<T>(
        &self,
        id: &str,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let registry = self
            .registry
            .lock()
            .map_err(|_| "任务状态不可用".to_string())?;
        let task = registry.tasks.get(id).ok_or_else(|| CANCELED.to_string())?;
        if registry.closed || *task.cancel.borrow() {
            return Err(CANCELED.into());
        }
        action()
    }
    async fn acquire(
        &self,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<OwnedSemaphorePermit, String> {
        tokio::select! {
            biased;
            _ = wait_canceled(cancel) => Err(CANCELED.into()),
            permit = self.slots.clone().acquire_owned() => permit.map_err(|_| CANCELED.into()),
        }
    }
}

fn validate_task_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 160
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("任务标识无效，请重新选择图片".into());
    }
    Ok(())
}

async fn wait_canceled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}
//#endregion

//#region 请求地址与图像边界
fn validate_output_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "服务返回了无效的下载地址".to_string())?;
    let token = ["/backend/opt/output/", "/web/output/", "/output/"]
        .iter()
        .find_map(|prefix| url.path().strip_prefix(prefix));
    let token_valid = token.is_some_and(|token| {
        !token.is_empty()
            && token.len() <= 512
            && token
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            && token != "."
            && token != ".."
    });
    if url.as_str() != raw
        || url.scheme() != "https"
        || !SITES.contains(&url.host_str().unwrap_or(""))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || url.query().is_some()
        || url.fragment().is_some()
        || !token_valid
    {
        return Err("服务返回了不受支持的下载地址，请稍后重试".into());
    }
    Ok(url)
}

pub fn validate_image(bytes: &[u8]) -> Result<(&'static str, u32, u32), String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片为空或超过 20MB，请选择较小的图片".into());
    }
    let format = image::guess_format(bytes)
        .map_err(|_| "文件不是有效的 PNG、JPG 或 WebP 图片".to_string())?;
    let mime = match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::WebP => "image/webp",
        _ => return Err("仅支持 PNG、JPG 和 WebP 图片".into()),
    };
    let (width, height) = image::ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| "图片已损坏，无法读取".to_string())?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return Err("图片尺寸过大，请先缩小图片".into());
    }
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(32_768);
    limits.max_image_height = Some(32_768);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| "图片内容不完整或已损坏，请换一张图片".to_string())?;
    Ok((mime, width, height))
}

fn network_client(https_only: bool) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(https_only)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(18))
        .build()
        .map_err(|_| "无法初始化网络连接，请重新启动应用".into())
}

fn random_forwarded_ip() -> Result<String, String> {
    let mut random = [0u8; 4];
    getrandom::fill(&mut random).map_err(|_| "无法准备压缩请求，请重试".to_string())?;
    Ok(format!(
        "{}.{}.{}.{}",
        11 + random[0] % 212,
        random[1],
        random[2],
        1 + random[3] % 253
    ))
}

fn status_error(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 | 403 => "匿名压缩被服务拒绝，请稍后再试".into(),
        429 => "压缩请求太频繁，请稍后再试".into(),
        413 => "服务拒绝了这张图片，请选择较小的图片".into(),
        300..=399 => "压缩服务返回了不受支持的跳转，请稍后重试".into(),
        _ => "压缩服务暂时不可用，请稍后重试".into(),
    }
}

async fn limited_body(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("服务返回的数据过大，请稍后重试".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "下载中断，请重试".to_string())?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("服务返回的数据过大，请稍后重试".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
//#endregion

//#region 匿名压缩
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionResult {
    pub temp_file_id: String,
    pub size: u64,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub site: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    task_id: &'a str,
    stage: &'a str,
}

#[derive(Deserialize)]
struct ShrinkResponse {
    output: ShrinkOutput,
}
#[derive(Deserialize)]
struct ShrinkOutput {
    url: String,
    size: u64,
    #[serde(rename = "type")]
    mime: String,
    width: u32,
    height: u32,
}

async fn compress_at_site(
    client: &reqwest::Client,
    site: &str,
    bytes: &[u8],
    input: (&str, u32, u32),
    mut progress: impl FnMut(&str),
) -> Result<Vec<u8>, String> {
    let origin = format!("https://{site}");
    progress("uploading");
    let response = client
        .post(format!("{origin}/backend/opt/shrink"))
        .header(reqwest::header::CONTENT_TYPE, input.0)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header(reqwest::header::ORIGIN, &origin)
        .header(reqwest::header::REFERER, format!("{origin}/"))
        .header("X-Forwarded-For", random_forwarded_ip()?)
        .body(bytes.to_vec())
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "压缩服务响应超时，请重试".to_string()
            } else {
                "无法连接压缩服务，请检查网络后重试".to_string()
            }
        })?;
    if !response.status().is_success() {
        return Err(status_error(response.status()));
    }
    let body = limited_body(response, 64 * 1024).await?;
    let output = serde_json::from_slice::<ShrinkResponse>(&body)
        .map_err(|_| "压缩服务返回了无法识别的结果，请稍后重试".to_string())?
        .output;
    if output.size == 0
        || output.size > MAX_IMAGE_BYTES as u64
        || (output.mime.as_str(), output.width, output.height) != input
    {
        return Err("压缩结果的格式或尺寸异常，请稍后重试".into());
    }
    let url = validate_output_url(&output.url)?;
    progress("downloading");
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "压缩结果下载失败，请重试".to_string())?;
    if !response.status().is_success() {
        return Err(status_error(response.status()));
    }
    let result = limited_body(response, MAX_IMAGE_BYTES).await?;
    if result.len() as u64 != output.size {
        return Err("压缩结果下载不完整，请重试".into());
    }
    let expected = (input.0.to_string(), input.1, input.2);
    tauri::async_runtime::spawn_blocking(move || {
        let decoded = validate_image(&result)?;
        if (decoded.0, decoded.1, decoded.2) != (expected.0.as_str(), expected.1, expected.2) {
            return Err("压缩结果的格式或尺寸异常，请重试".into());
        }
        Ok(result)
    })
    .await
    .map_err(|_| "压缩结果校验失败，请重试".to_string())?
}

pub async fn compress<R: tauri::Runtime>(
    app: AppHandle<R>,
    source_id: String,
    task_id: String,
) -> Result<CompressionResult, String> {
    let state = app.state::<CompressionState>();
    let mut cancel = state.register(&task_id)?;
    let mut slot_cancel = cancel.clone();
    let work = async {
        let _permit = state.acquire(&mut slot_cancel).await?;
        let input_app = app.clone();
        let (source, bytes, input) = tauri::async_runtime::spawn_blocking(move || {
            let files = input_app.state::<FileState>();
            let source = file_ops::source_record(&files, &source_id)?;
            let bytes = file_ops::read_source(&files, &source_id)?;
            let input = validate_image(&bytes)?;
            Ok::<_, String>((source, bytes, input))
        })
        .await
        .map_err(|_| "图片读取失败，请重试".to_string())??;
        let client = network_client(true)?;
        let mut last_error = "压缩服务暂时不可用，请稍后重试".to_string();
        for site in SITES {
            match compress_at_site(&client, site, &bytes, input, |stage| {
                let _ = app.emit(
                    "lite-progress",
                    Progress {
                        task_id: &task_id,
                        stage,
                    },
                );
            })
            .await
            {
                Ok(bytes) => {
                    let directory = app
                        .path()
                        .temp_dir()
                        .unwrap_or_else(|_| std::env::temp_dir())
                        .join(format!("tinypng-lite-{}", std::process::id()));
                    let output_app = app.clone();
                    let output_task = task_id.clone();
                    let size = bytes.len() as u64;
                    let pending = tauri::async_runtime::spawn_blocking(move || {
                        file_ops::write_result(
                            &output_app.state::<FileState>(),
                            &directory,
                            &output_task,
                            &source,
                            &bytes,
                            input.0,
                        )
                    })
                    .await
                    .map_err(|_| "压缩结果暂存失败，请重试".to_string())??;
                    // 写盘不持有任务锁；取消或超时后，未登记的结果会自动删除。
                    return state.finalize(&task_id, || {
                        let temp = pending.register(&app.state::<FileState>())?;
                        Ok(CompressionResult {
                            temp_file_id: temp.id,
                            size,
                            mime: input.0.into(),
                            width: input.1,
                            height: input.2,
                            site: (*site).into(),
                        })
                    });
                }
                Err(message) => last_error = message,
            }
        }
        Err(last_error)
    };
    let result = tokio::select! {
        biased;
        _ = wait_canceled(&mut cancel) => Err(CANCELED.into()),
        result = tokio::time::timeout(Duration::from_secs(60), work) => result.unwrap_or_else(|_| Err("压缩超过 60 秒，请检查网络后重试".into())),
    };
    if result.is_err() {
        let _ = state.cancel(&task_id);
        let _ = file_ops::cleanup(&app.state::<FileState>(), &task_id);
    }
    result
}
//#endregion

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    #[test]
    fn output_url_accepts_only_fixed_https_hosts_and_result_paths() {
        for host in ["tinypng.com", "tinyjpg.com", "tinify.cn"] {
            assert!(validate_output_url(&format!(
                "https://{host}/backend/opt/output/result-token"
            ))
            .is_ok());
        }
        for raw in [
            "http://tinypng.com/backend/opt/output/a",
            "https://tinypng.com.evil.test/backend/opt/output/a",
            "https://evil.test/backend/opt/output/a",
            "https://user:secret@tinypng.com/backend/opt/output/a",
            "https://@tinypng.com/backend/opt/output/a",
            "https://tinypng.com/backend/opt/output/a/../b",
            "https://tinypng.com:444/backend/opt/output/a",
            "https://tinypng.com/backend/opt/shrink",
            "https://tinypng.com/backend/opt/output/",
            "https://tinypng.com/backend/opt/output/a?url=https://evil.test",
            "https://tinypng.com/backend/opt/output/%2e%2e/shrink",
            "https://tinypng.com/backend/opt/output/a/b",
        ] {
            assert!(validate_output_url(raw).is_err(), "must reject {raw}");
        }
    }

    #[test]
    fn a_valid_png_is_fully_decoded() {
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(2, 3)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        assert_eq!(
            validate_image(bytes.get_ref()).unwrap(),
            ("image/png", 2, 3)
        );
        bytes.get_mut().truncate(40);
        assert!(validate_image(bytes.get_ref()).is_err());
        assert!(validate_image(b"<html>upstream blocked</html>").is_err());
        assert!(validate_image(&vec![0; MAX_IMAGE_BYTES + 1]).is_err());
    }

    #[test]
    fn valid_png_padding_between_decimal_mb_and_mib_is_rejected() {
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(2, 3)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.get_mut().resize(20_000_000, 0);
        assert_eq!(
            validate_image(bytes.get_ref()).unwrap(),
            ("image/png", 2, 3)
        );
        bytes.get_mut().push(0);
        assert!(validate_image(bytes.get_ref()).is_err());
    }

    #[test]
    fn valid_jpeg_and_webp_are_identified_from_actual_bytes() {
        for (format, mime) in [
            (image::ImageFormat::Jpeg, "image/jpeg"),
            (image::ImageFormat::WebP, "image/webp"),
        ] {
            let mut bytes = Cursor::new(Vec::new());
            image::DynamicImage::new_rgb8(3, 2)
                .write_to(&mut bytes, format)
                .unwrap();
            assert_eq!(validate_image(bytes.get_ref()).unwrap(), (mime, 3, 2));
        }
    }

    #[test]
    fn upstream_denials_are_friendly_and_do_not_expose_response_content() {
        for code in [401, 403] {
            assert_eq!(
                status_error(reqwest::StatusCode::from_u16(code).unwrap()),
                "匿名压缩被服务拒绝，请稍后再试"
            );
        }
        assert_eq!(
            status_error(reqwest::StatusCode::TOO_MANY_REQUESTS),
            "压缩请求太频繁，请稍后再试"
        );
    }

    #[test]
    fn cancel_before_registration_is_not_lost() {
        let state = CompressionState::default();
        state.cancel("session-item-1").unwrap();
        assert!(state.register("session-item-1").is_err());
    }

    #[test]
    fn canceled_late_results_cannot_be_registered() {
        let state = CompressionState::default();
        let _cancel = state.register("session-item-1").unwrap();
        state.cancel("session-item-1").unwrap();
        let wrote = AtomicBool::new(false);
        assert!(state
            .finalize("session-item-1", || {
                wrote.store(true, Ordering::SeqCst);
                Ok(())
            })
            .is_err());
        assert!(!wrote.load(Ordering::SeqCst));
    }

    #[test]
    fn cleaned_session_rejects_late_new_requests() {
        let state = CompressionState::default();
        state.cancel_session("session").unwrap();
        assert!(state.register("session-new-2").is_err());
        assert!(state.register("session2-new-2").is_ok());
    }

    #[tokio::test]
    async fn five_slots_bound_work_and_cancel_interrupts_a_waiter() {
        let state = CompressionState::default();
        let mut permits = Vec::new();
        for index in 0..5 {
            let mut cancel = state.register(&format!("session-{index}-1")).unwrap();
            permits.push(state.acquire(&mut cancel).await.unwrap());
        }
        assert_eq!(state.slots.available_permits(), 0);
        let mut cancel = state.register("session-waiter-1").unwrap();
        state.cancel("session-waiter-1").unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), state.acquire(&mut cancel))
                .await
                .unwrap()
                .is_err()
        );
        drop(permits);
        assert_eq!(state.slots.available_permits(), 5);
    }

    fn serve_once(response: &'static str) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/test", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            stream.read(&mut request).unwrap();
            stream.write_all(response.as_bytes()).unwrap();
        });
        (url, handle)
    }

    #[tokio::test]
    async fn network_client_never_follows_redirects_and_requires_https() {
        let (url, server) = serve_once("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/evil\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        let response = network_client(false)
            .unwrap()
            .get(&url)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        assert_eq!(response.url().as_str(), url);
        assert!(network_client(true)
            .unwrap()
            .get(&url)
            .send()
            .await
            .is_err());
        server.join().unwrap();
    }

    #[tokio::test]
    async fn response_cap_rejects_announced_and_chunked_overflow() {
        for response in [
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
        ] {
            let (url, server) = serve_once(response);
            let response = network_client(false).unwrap().get(url).send().await.unwrap();
            assert!(limited_body(response, 4).await.is_err());
            server.join().unwrap();
        }
    }

    #[test]
    fn canceled_all_work_blocks_new_and_late_results() {
        let state = CompressionState::default();
        state.register("session-item-1").unwrap();
        state.cancel_all();
        assert!(state.register("other-item-1").is_err());
        assert!(state.finalize("session-item-1", || Ok(())).is_err());
    }

    #[tokio::test]
    #[ignore = "仅人工指定执行一次真实合成图匿名上传"]
    async fn live_anonymous_synthetic_png() {
        let bytes =
            std::fs::read("/private/tmp/tinypng-phase1-recovery-local/fixtures/sample-one.png")
                .unwrap();
        let input = validate_image(&bytes).unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(60),
            compress_at_site(
                &network_client(true).unwrap(),
                "tinypng.com",
                &bytes,
                input,
                |stage| eprintln!("native live stage: {stage}"),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(validate_image(&result).unwrap(), input);
        std::fs::write("/private/tmp/tinypng-lite-native-live.png", &result).unwrap();
        eprintln!(
            "native live PNG: {} -> {} bytes, {}x{}",
            bytes.len(),
            result.len(),
            input.1,
            input.2
        );
    }
}
