use crate::compression::MAX_IMAGE_BYTES;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const SUPPORTED_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp"];

//#region 已授权来源与临时结果
#[derive(Default)]
pub struct FileState {
    pub sources: Mutex<HashMap<String, SourceRecord>>,
    pub temps: Mutex<HashMap<String, TempRecord>>,
    pub overwrite_gate: Mutex<()>,
    next_id: AtomicU64,
}

#[derive(Clone)]
pub struct SourceRecord {
    pub path: PathBuf,
    pub metadata: FileDescriptor,
}

#[derive(Clone)]
pub struct TempRecord {
    pub path: PathBuf,
    pub session_id: String,
    pub metadata: FileDescriptor,
    pub original: Option<OriginalSnapshot>,
}

#[derive(Clone)]
pub struct OriginalSnapshot {
    pub path: PathBuf,
    pub digest: [u8; 32],
    pub result_digest: [u8; 32],
}

pub struct PendingResult {
    record: Option<TempRecord>,
}

impl PendingResult {
    pub fn register(mut self, state: &FileState) -> Result<FileDescriptor, String> {
        let mut temps = state
            .temps
            .lock()
            .map_err(|_| "文件状态不可用".to_string())?;
        let record = self
            .record
            .take()
            .ok_or_else(|| "压缩结果已失效".to_string())?;
        let descriptor = record.metadata.clone();
        temps.insert(descriptor.id.clone(), record);
        Ok(descriptor)
    }
}

impl Drop for PendingResult {
    fn drop(&mut self) {
        if let Some(record) = &self.record {
            let _ = fs::remove_file(&record.path);
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDescriptor {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub relative_path: String,
    pub last_modified: Option<i64>,
    pub handle: Option<String>,
}

impl FileState {
    pub fn new_id(&self, prefix: &str) -> String {
        format!("{prefix}-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }
}

pub fn collect_files(
    state: &FileState,
    root: &Path,
    recursive: bool,
) -> Result<Vec<FileDescriptor>, String> {
    let root =
        fs::canonicalize(root).map_err(|_| "所选文件或目录已经不存在，请重新选择".to_string())?;
    let mut paths = Vec::new();
    if recursive {
        collect_directory(&root, &mut paths)?;
    } else if root.is_file() && is_supported(&root) {
        paths.push(root.to_path_buf());
    }
    let mut descriptors = Vec::with_capacity(paths.len());
    let mut sources = state
        .sources
        .lock()
        .map_err(|_| "文件状态不可用".to_string())?;
    for path in paths {
        let metadata = fs::metadata(&path).map_err(|error| format!("读取文件信息失败: {error}"))?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES as u64 {
            continue;
        }
        let path = fs::canonicalize(path).map_err(|_| "无法读取选择的图片".to_string())?;
        // 重复选择同一规范路径时复用标识，前端按来源标识即可去重。
        let id = sources
            .iter()
            .find_map(|(id, source)| (source.path == path).then(|| id.clone()))
            .unwrap_or_else(|| state.new_id("source"));
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let descriptor = FileDescriptor {
            id: id.clone(),
            name: name.clone(),
            size: metadata.len(),
            mime: mime_for_path(&path),
            relative_path: if recursive {
                path.strip_prefix(&root)
                    .unwrap_or(path.as_path())
                    .to_string_lossy()
                    .replace('\\', "/")
            } else {
                name
            },
            last_modified: metadata.modified().ok().and_then(|time| {
                time.duration_since(std::time::UNIX_EPOCH)
                    .ok()
                    .map(|duration| duration.as_millis() as i64)
            }),
            handle: None,
        };
        sources.insert(
            id,
            SourceRecord {
                path,
                metadata: descriptor.clone(),
            },
        );
        descriptors.push(descriptor);
    }
    Ok(descriptors)
}

fn collect_directory(current: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|error| format!("扫描目录失败: {error}"))? {
        let entry = entry.map_err(|error| format!("读取目录项失败: {error}"))?;
        let kind = entry
            .file_type()
            .map_err(|error| format!("读取目录项类型失败: {error}"))?;
        if kind.is_symlink() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            collect_directory(&path, output)?;
        } else if kind.is_file() && is_supported(&path) {
            output.push(path);
        }
    }
    Ok(())
}

pub fn source_record(state: &FileState, source_id: &str) -> Result<SourceRecord, String> {
    state
        .sources
        .lock()
        .map_err(|_| "文件状态不可用".to_string())?
        .get(source_id)
        .cloned()
        .ok_or_else(|| "来源文件已失效，请重新选择".into())
}

pub fn read_source(state: &FileState, source_id: &str) -> Result<Vec<u8>, String> {
    let record = source_record(state, source_id)?;
    let file =
        File::open(&record.path).map_err(|_| "图片无法读取，请确认文件仍然存在".to_string())?;
    let metadata = file
        .metadata()
        .map_err(|_| "图片信息无法读取".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES as u64 {
        return Err("图片为空或超过 20MB，请选择较小的图片".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "图片读取失败，请重新选择".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片为空或超过 20MB，请选择较小的图片".into());
    }
    Ok(bytes)
}

pub fn write_result(
    state: &FileState,
    directory: &Path,
    task_id: &str,
    source: &SourceRecord,
    bytes: &[u8],
    mime: &str,
    source_fingerprint: [u8; 32],
) -> Result<PendingResult, String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("压缩结果为空或过大，请重试".into());
    }
    fs::create_dir_all(directory).map_err(|_| "无法准备临时保存位置".to_string())?;
    let id = state.new_id("temp");
    let path = directory.join(format!(".shrinkdrop-{task_id}-{id}.tmp"));
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(|_| "无法创建压缩结果".to_string())?;
    if output
        .write_all(bytes)
        .and_then(|_| output.flush())
        .and_then(|_| output.sync_all())
        .is_err()
    {
        drop(output);
        let _ = fs::remove_file(&path);
        return Err("压缩结果暂存失败，请重试".into());
    }
    let descriptor = FileDescriptor {
        id: id.clone(),
        name: compressed_name(&source.metadata.name, mime),
        size: bytes.len() as u64,
        mime: mime.into(),
        relative_path: source.metadata.relative_path.clone(),
        last_modified: None,
        handle: Some(id.clone()),
    };
    Ok(PendingResult {
        record: Some(TempRecord {
            path,
            session_id: task_id.into(),
            metadata: descriptor,
            original: Some(OriginalSnapshot {
                path: source.path.clone(),
                digest: source_fingerprint,
                result_digest: crate::overwrite::fingerprint(bytes),
            }),
        }),
    })
}

fn compressed_name(name: &str, mime: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let extension = match mime {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => "png",
    };
    format!("{stem}.min.{extension}")
}

pub fn cleanup(state: &FileState, session_id: &str) -> Result<(), String> {
    let prefix = format!("{session_id}-");
    cleanup_matching(state, |record| {
        record.session_id == session_id || record.session_id.starts_with(&prefix)
    })
}

pub fn cleanup_all(state: &FileState) -> Result<(), String> {
    cleanup_matching(state, |_| true)
}

fn cleanup_matching(
    state: &FileState,
    matches: impl Fn(&TempRecord) -> bool,
) -> Result<(), String> {
    let mut temps = state
        .temps
        .lock()
        .map_err(|_| "文件状态不可用".to_string())?;
    let ids: Vec<_> = temps
        .iter()
        .filter(|(_, record)| matches(record))
        .map(|(id, _)| id.clone())
        .collect();
    let mut failed = false;
    for id in ids {
        if let Some(record) = temps.get(&id) {
            match fs::remove_file(&record.path) {
                Ok(()) => {
                    temps.remove(&id);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    temps.remove(&id);
                }
                Err(_) => failed = true,
            }
        }
    }
    if failed {
        Err("部分临时文件清理失败，请重新启动应用后重试".into())
    } else {
        Ok(())
    }
}

fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            SUPPORTED_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
}

fn mime_for_path(path: &Path) -> String {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
    .into()
}
//#endregion

//#region 保存副本与原图保护
pub fn save_temp_to_path(
    state: &FileState,
    temp_id: &str,
    destination: &Path,
) -> Result<(), String> {
    let record = state
        .temps
        .lock()
        .map_err(|_| "文件状态不可用".to_string())?
        .get(temp_id)
        .cloned()
        .ok_or_else(|| "压缩结果已失效，请重新处理".to_string())?;
    let parent = destination
        .parent()
        .ok_or_else(|| "保存目录无效".to_string())?;
    let name = destination
        .file_name()
        .ok_or_else(|| "保存文件名无效".to_string())?;
    let resolved_parent =
        fs::canonicalize(parent).map_err(|_| "无法访问保存目录，请换一个位置".to_string())?;
    let resolved = if destination.exists() {
        fs::canonicalize(destination).ok()
    } else {
        Some(resolved_parent.join(name))
    };
    let sources = state
        .sources
        .lock()
        .map_err(|_| "文件状态不可用".to_string())?;
    if sources.values().any(|source| {
        Some(&source.path) == resolved.as_ref()
            || same_file::is_same_file(&source.path, destination).unwrap_or(false)
    }) {
        return Err("请换一个文件名或目录，保存结果不能覆盖原图".into());
    }
    drop(sources);
    if same_file::is_same_file(&record.path, destination).unwrap_or(false) {
        return Err("保存位置不能是压缩结果的临时文件".into());
    }
    if fs::symlink_metadata(destination).is_ok() {
        return Err("目标文件已存在，请换一个文件名".into());
    }
    let scratch = resolved_parent.join(format!(
        ".shrinkdrop-{}-{}.tmp",
        std::process::id(),
        state.new_id("save")
    ));
    let result = (|| {
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&scratch)
            .map_err(|_| "无法创建保存文件，请换一个目录".to_string())?;
        let mut input =
            File::open(&record.path).map_err(|_| "压缩结果无法读取，请重新处理".to_string())?;
        std::io::copy(&mut input, &mut output)
            .map_err(|_| "保存失败，请检查可用空间后重试".to_string())?;
        output
            .flush()
            .and_then(|_| output.sync_all())
            .map_err(|_| "保存失败，请检查可用空间后重试".to_string())?;
        drop(output);
        // 同目录硬链接原子发布且不替换现有文件，防止保存期间目标被替换为原图别名。
        publish_without_replace(
            &scratch,
            &resolved_parent.join(name),
            |source, destination| fs::hard_link(source, destination),
            |input, output| std::io::copy(input, output),
        )
        .map_err(|_| "保存失败，目标文件已存在或目录不可写".to_string())?;
        Ok(())
    })();
    let _ = fs::remove_file(&scratch);
    result
}

fn publish_without_replace<H, C>(
    scratch: &Path,
    destination: &Path,
    hard_link: H,
    copy: C,
) -> std::io::Result<()>
where
    H: FnOnce(&Path, &Path) -> std::io::Result<()>,
    C: FnOnce(&mut File, &mut File) -> std::io::Result<u64>,
{
    match hard_link(scratch, destination) {
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Err(error),
        Err(_) => {}
    }
    // exFAT/FAT32 等文件系统不支持硬链接时，独占创建副本并在失败后删除未完成文件。
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)?;
    let result = (|| {
        let mut input = File::open(scratch)?;
        copy(&mut input, &mut output)?;
        output.flush()?;
        output.sync_all()
    })();
    drop(output);
    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}

#[derive(Serialize)]
pub struct SaveFailure {
    pub id: String,
    pub name: String,
    pub message: String,
}
#[derive(Serialize)]
pub struct BatchSaveResult {
    pub saved: usize,
    pub failed: Vec<SaveFailure>,
    pub canceled: bool,
}

pub fn save_to_directory(state: &FileState, ids: &[String], directory: &Path) -> BatchSaveResult {
    let mut result = BatchSaveResult {
        saved: 0,
        failed: Vec::new(),
        canceled: false,
    };
    let mut seen = HashSet::new();
    for id in ids {
        if !seen.insert(id) {
            continue;
        }
        let record = state
            .temps
            .lock()
            .ok()
            .and_then(|temps| temps.get(id).cloned());
        let name = record
            .as_ref()
            .map(|record| record.metadata.name.clone())
            .unwrap_or_else(|| "图片".into());
        let save = record
            .ok_or_else(|| "压缩结果已失效，请重新处理".to_string())
            .and_then(|record| {
                let stem = Path::new(&record.metadata.name)
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy();
                let extension = Path::new(&record.metadata.name)
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy();
                for index in 0..10_000 {
                    let filename = if index == 0 {
                        record.metadata.name.clone()
                    } else {
                        format!("{stem} ({index}).{extension}")
                    };
                    let destination = directory.join(filename);
                    if fs::symlink_metadata(&destination).is_ok() {
                        continue;
                    }
                    match save_temp_to_path(state, id, &destination) {
                        Ok(()) => return Ok(()),
                        Err(_) if fs::symlink_metadata(&destination).is_ok() => continue,
                        Err(message) => return Err(message),
                    }
                }
                Err("同名文件过多，请换一个保存目录".into())
            });
        match save {
            Ok(()) => result.saved += 1,
            Err(message) => result.failed.push(SaveFailure {
                id: id.clone(),
                name,
                message,
            }),
        }
    }
    result
}
//#endregion

#[cfg(test)]
mod download_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static SERIAL: AtomicUsize = AtomicUsize::new(0);
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "shrinkdrop-save-test-{}-{stamp}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn register_result(&self, state: &FileState) -> PathBuf {
            let path = self.0.join("result.tmp");
            fs::write(&path, b"processed-image").unwrap();
            state.temps.lock().unwrap().insert(
                "temp-result".into(),
                TempRecord {
                    path: path.clone(),
                    session_id: "test".into(),
                    metadata: FileDescriptor {
                        id: "temp-result".into(),
                        name: "image.webp".into(),
                        size: 15,
                        mime: "image/webp".into(),
                        relative_path: "image.webp".into(),
                        last_modified: None,
                        handle: Some("temp-result".into()),
                    },
                    original: None,
                },
            );
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn unsupported_link(_: &Path, _: &Path) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "hard links unsupported",
        ))
    }

    #[test]
    fn unsupported_hard_links_fall_back_to_a_new_copy() {
        let fixture = Fixture::new();
        let source = fixture.0.join("scratch.tmp");
        let destination = fixture.0.join("photo.min.png");
        fs::write(&source, b"compressed-image").unwrap();
        publish_without_replace(&source, &destination, unsupported_link, |input, output| {
            std::io::copy(input, output)
        })
        .unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"compressed-image");
        assert_eq!(fs::read(&source).unwrap(), b"compressed-image");
    }

    #[test]
    fn hard_link_permission_errors_also_use_safe_copy_fallback() {
        let fixture = Fixture::new();
        let source = fixture.0.join("scratch.tmp");
        let destination = fixture.0.join("photo.min.png");
        fs::write(&source, b"compressed-image").unwrap();
        publish_without_replace(
            &source,
            &destination,
            |_, _| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "hard link denied",
                ))
            },
            |input, output| std::io::copy(input, output),
        )
        .unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"compressed-image");
        assert_eq!(fs::read(&source).unwrap(), b"compressed-image");
    }

    #[test]
    fn fallback_copy_does_not_replace_a_colliding_destination() {
        let fixture = Fixture::new();
        let source = fixture.0.join("scratch.tmp");
        let destination = fixture.0.join("photo.png");
        fs::write(&source, b"compressed-image").unwrap();
        fs::write(&destination, b"original-image").unwrap();
        let error =
            publish_without_replace(&source, &destination, unsupported_link, |input, output| {
                std::io::copy(input, output)
            })
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&destination).unwrap(), b"original-image");
    }

    #[test]
    fn failed_fallback_copy_removes_the_partial_destination() {
        let fixture = Fixture::new();
        let source = fixture.0.join("scratch.tmp");
        let destination = fixture.0.join("photo.min.png");
        fs::write(&source, b"compressed-image").unwrap();
        let copied = std::cell::Cell::new(false);
        let result =
            publish_without_replace(&source, &destination, unsupported_link, |_, output| {
                copied.set(true);
                output.write_all(b"partial-image")?;
                Err(std::io::Error::other("disk full"))
            });
        assert!(copied.get());
        assert!(result.is_err());
        assert!(!destination.exists());
        assert_eq!(fs::read(&source).unwrap(), b"compressed-image");
    }

    #[cfg(unix)]
    #[test]
    fn fallback_cannot_write_through_an_existing_symlink() {
        let fixture = Fixture::new();
        let source = fixture.0.join("scratch.tmp");
        let original = fixture.0.join("original.png");
        let destination = fixture.0.join("alias.png");
        fs::write(&source, b"compressed-image").unwrap();
        fs::write(&original, b"original-image").unwrap();
        std::os::unix::fs::symlink(&original, &destination).unwrap();
        let error =
            publish_without_replace(&source, &destination, unsupported_link, |input, output| {
                std::io::copy(input, output)
            })
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&original).unwrap(), b"original-image");
        assert!(fs::symlink_metadata(&destination)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn saves_registered_result_and_keeps_it_available_for_retry() {
        let fixture = Fixture::new();
        let state = FileState::default();
        let result = fixture.register_result(&state);
        let output = fixture.0.join("download.webp");
        save_temp_to_path(&state, "temp-result", &output).unwrap();
        assert_eq!(fs::read(&output).unwrap(), b"processed-image");
        assert_eq!(fs::read(&result).unwrap(), b"processed-image");
    }

    #[test]
    fn unknown_result_cannot_write_a_file() {
        let fixture = Fixture::new();
        let output = fixture.0.join("download.webp");
        assert!(save_temp_to_path(&FileState::default(), "missing", &output).is_err());
        assert!(!output.exists());
    }

    #[test]
    fn downloaded_result_cannot_overwrite_an_imported_original() {
        let fixture = Fixture::new();
        let state = FileState::default();
        fixture.register_result(&state);
        let original = fixture.0.join("original.png");
        fs::write(&original, b"original-image").unwrap();
        collect_files(&state, &original, false).unwrap();
        assert!(save_temp_to_path(&state, "temp-result", &original).is_err());
        assert_eq!(fs::read(&original).unwrap(), b"original-image");
        #[cfg(unix)]
        {
            let alias = fixture.0.join("alias.png");
            std::os::unix::fs::symlink(&original, &alias).unwrap();
            assert!(save_temp_to_path(&state, "temp-result", &alias).is_err());
            assert_eq!(fs::read(&original).unwrap(), b"original-image");
        }
    }

    #[test]
    fn oversized_sources_are_not_registered() {
        let fixture = Fixture::new();
        let source = fixture.0.join("huge.png");
        File::create(&source).unwrap().set_len(20_000_001).unwrap();
        let state = FileState::default();
        assert!(collect_files(&state, &source, false).unwrap().is_empty());
        assert!(state.sources.lock().unwrap().is_empty());
    }

    #[test]
    fn repeated_source_import_reuses_the_registered_id() {
        let fixture = Fixture::new();
        let source = fixture.0.join("photo.png");
        fs::write(&source, b"original-image").unwrap();
        let state = FileState::default();
        let first = collect_files(&state, &source, false).unwrap();
        let second = collect_files(&state, &source, false).unwrap();
        assert_eq!(first[0].id, second[0].id);
        assert_eq!(state.sources.lock().unwrap().len(), 1);
        #[cfg(unix)]
        {
            let alias = fixture.0.join("alias.png");
            std::os::unix::fs::symlink(&source, &alias).unwrap();
            let aliases = collect_files(&state, &alias, false).unwrap();
            assert_eq!(first[0].id, aliases[0].id);
        }
    }

    #[test]
    fn source_growing_after_import_is_rejected_before_read() {
        let fixture = Fixture::new();
        let source = fixture.0.join("growing.png");
        fs::write(&source, b"original-image").unwrap();
        let state = FileState::default();
        let id = collect_files(&state, &source, false).unwrap()[0].id.clone();
        File::create(&source).unwrap().set_len(20_000_001).unwrap();
        assert!(read_source(&state, &id).is_err());
    }

    #[test]
    fn result_cannot_overwrite_original_hard_link() {
        let fixture = Fixture::new();
        let state = FileState::default();
        fixture.register_result(&state);
        let original = fixture.0.join("original.png");
        let alias = fixture.0.join("alias.png");
        fs::write(&original, b"original-image").unwrap();
        fs::hard_link(&original, &alias).unwrap();
        collect_files(&state, &original, false).unwrap();
        assert!(save_temp_to_path(&state, "temp-result", &alias).is_err());
        assert_eq!(fs::read(&original).unwrap(), b"original-image");
    }

    #[test]
    fn bulk_save_adds_collision_suffixes_and_reports_partial_failure() {
        let fixture = Fixture::new();
        let state = FileState::default();
        let result_path = fixture.register_result(&state);
        state
            .temps
            .lock()
            .unwrap()
            .get_mut("temp-result")
            .unwrap()
            .metadata
            .name = "image.min.webp".into();
        fs::write(fixture.0.join("image.min.webp"), b"keep-existing").unwrap();
        let result = save_to_directory(
            &state,
            &["temp-result".into(), "missing".into()],
            &fixture.0,
        );
        assert_eq!(result.saved, 1);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].id, "missing");
        assert_eq!(
            fs::read(fixture.0.join("image.min.webp")).unwrap(),
            b"keep-existing"
        );
        assert_eq!(
            fs::read(fixture.0.join("image.min (1).webp")).unwrap(),
            b"processed-image"
        );
        assert!(result_path.exists());
    }

    #[test]
    fn session_cleanup_uses_task_prefix_and_keeps_other_sessions() {
        let fixture = Fixture::new();
        let state = FileState::default();
        fixture.register_result(&state);
        state
            .temps
            .lock()
            .unwrap()
            .get_mut("temp-result")
            .unwrap()
            .session_id = "session-item-1".into();
        cleanup(&state, "session2").unwrap();
        assert!(state.temps.lock().unwrap().contains_key("temp-result"));
        cleanup(&state, "session").unwrap();
        assert!(state.temps.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn selected_directory_alias_never_exposes_absolute_paths() {
        let fixture = Fixture::new();
        let directory = fixture.0.join("images");
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("photo.png"), b"original-image").unwrap();
        let alias = fixture.0.join("selected-folder");
        std::os::unix::fs::symlink(&directory, &alias).unwrap();
        let files = collect_files(&FileState::default(), &alias, true).unwrap();
        assert_eq!(files[0].relative_path, "photo.png");
    }

    #[test]
    fn preparing_result_does_not_register_and_dropped_pending_file_is_removed() {
        let fixture = Fixture::new();
        let state = FileState::default();
        let original = fixture.0.join("photo.png");
        fs::write(&original, b"original-image").unwrap();
        let id = collect_files(&state, &original, false).unwrap()[0]
            .id
            .clone();
        let source = source_record(&state, &id).unwrap();
        let directory = fixture.0.join("temporary");
        let pending = write_result(
            &state,
            &directory,
            "session-item-1",
            &source,
            b"compressed-image",
            "image/png",
            crate::overwrite::fingerprint(b"original-image"),
        )
        .unwrap();
        assert!(state.temps.lock().unwrap().is_empty());
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        drop(pending);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
    }

    #[test]
    fn registered_pending_result_has_compressed_name_and_survives_guard_drop() {
        let fixture = Fixture::new();
        let state = FileState::default();
        let original = fixture.0.join("photo.png");
        fs::write(&original, b"original-image").unwrap();
        let id = collect_files(&state, &original, false).unwrap()[0]
            .id
            .clone();
        let source = source_record(&state, &id).unwrap();
        let pending = write_result(
            &state,
            &fixture.0.join("temporary"),
            "session-item-1",
            &source,
            b"compressed-image",
            "image/png",
            crate::overwrite::fingerprint(b"original-image"),
        )
        .unwrap();
        let descriptor = pending.register(&state).unwrap();
        assert_eq!(descriptor.name, "photo.min.png");
        assert_eq!(descriptor.relative_path, "photo.png");
        let path = state
            .temps
            .lock()
            .unwrap()
            .get(&descriptor.id)
            .unwrap()
            .path
            .clone();
        assert_eq!(fs::read(&path).unwrap(), b"compressed-image");
        cleanup(&state, "session").unwrap();
        assert!(!path.exists());
    }
}
