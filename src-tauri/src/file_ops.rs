use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Manager;

const SUPPORTED_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp"];

#[derive(Default)]
pub struct FileState {
    pub sources: Mutex<HashMap<String, SourceRecord>>,
    pub temps: Mutex<HashMap<String, TempRecord>>,
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
        let value = self.next_id.fetch_add(1, Ordering::Relaxed);
        format!("{prefix}-{value}")
    }
}

pub fn collect_files(
    state: &FileState,
    root: &Path,
    recursive: bool,
) -> Result<Vec<FileDescriptor>, String> {
    let mut paths = Vec::new();
    if recursive {
        collect_directory(root, root, &mut paths)?;
    } else if root.is_file() {
        paths.push(root.to_path_buf());
    }

    let mut descriptors = Vec::with_capacity(paths.len());
    let mut sources = state
        .sources
        .lock()
        .map_err(|_| "文件状态锁已损坏".to_string())?;
    for path in paths {
        let metadata = fs::metadata(&path).map_err(|error| format!("读取文件信息失败: {error}"))?;
        let id = state.new_id("source");
        let relative_path = if recursive {
            path.strip_prefix(root)
                .unwrap_or(path.as_path())
                .to_string_lossy()
                .replace('\\', "/")
        } else {
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        };
        let descriptor = FileDescriptor {
            id: id.clone(),
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            size: metadata.len(),
            mime: mime_for_path(&path),
            relative_path,
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

fn collect_directory(root: &Path, current: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(current).map_err(|error| format!("扫描目录失败: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取目录项失败: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取目录项类型失败: {error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_symlink() || name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_directory(root, &path, output)?;
        } else if file_type.is_file() && is_supported(&path) {
            output.push(path);
        }
    }
    Ok(())
}

pub fn read_source(state: &FileState, source_id: &str) -> Result<Vec<u8>, String> {
    let sources = state
        .sources
        .lock()
        .map_err(|_| "文件状态锁已损坏".to_string())?;
    let record = sources
        .get(source_id)
        .ok_or_else(|| "来源文件已失效，请重新选择".to_string())?;
    fs::read(&record.path).map_err(|error| format!("读取文件失败: {error}"))
}

pub fn write_temp<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &FileState,
    task_id: &str,
    bytes: &[u8],
    extension: &str,
    mime: &str,
) -> Result<FileDescriptor, String> {
    if bytes.is_empty() {
        return Err("压缩结果为空，无法写入临时文件".to_string());
    }
    let extension = clean_extension(extension)?;
    let source = state
        .sources
        .lock()
        .map_err(|_| "文件状态锁已损坏".to_string())?
        .iter()
        .find(|(source_id, _)| task_id.ends_with(&format!("-{source_id}")))
        .map(|(_, source)| source.clone());

    let directory = source
        .as_ref()
        .and_then(|record| record.path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| {
            app.path()
                .temp_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
        });
    fs::create_dir_all(&directory).map_err(|error| format!("创建临时文件目录失败: {error}"))?;

    let temp_id = state.new_id("temp");
    let name = format!(".tinypng-{task_id}-{temp_id}.{extension}");
    let path = directory.join(name);
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(|error| format!("创建临时文件失败: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("写入临时文件失败: {error}"))?;
    file.flush()
        .map_err(|error| format!("刷新临时文件失败: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("持久化临时文件失败: {error}"))?;

    let relative_path = source
        .as_ref()
        .map(|record| record.metadata.relative_path.clone())
        .unwrap_or_else(|| format!("{task_id}.{extension}"));
    let descriptor = FileDescriptor {
        id: temp_id.clone(),
        name: format!("{task_id}.{extension}"),
        size: bytes.len() as u64,
        mime: mime.to_string(),
        relative_path,
        last_modified: None,
        handle: Some(temp_id.clone()),
    };
    state
        .temps
        .lock()
        .map_err(|_| "文件状态锁已损坏".to_string())?
        .insert(
            temp_id,
            TempRecord {
                path,
                session_id: task_id.to_string(),
                metadata: descriptor.clone(),
            },
        );
    Ok(descriptor)
}

pub fn replace_original(state: &FileState, temp_id: &str, source_id: &str) -> Result<(), String> {
    let source = state
        .sources
        .lock()
        .map_err(|_| "文件状态锁已损坏".to_string())?
        .get(source_id)
        .cloned()
        .ok_or_else(|| "来源文件已失效，请重新选择".to_string())?;
    let temp = state
        .temps
        .lock()
        .map_err(|_| "文件状态锁已损坏".to_string())?
        .get(temp_id)
        .cloned()
        .ok_or_else(|| "临时文件已失效，请重新压缩".to_string())?;

    if source.path.parent() != temp.path.parent() {
        return Err("临时文件与原图不在同一目录，无法安全覆盖".to_string());
    }
    let file = File::open(&temp.path).map_err(|error| format!("打开临时文件失败: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("持久化临时文件失败: {error}"))?;
    atomic_replace(&temp.path, &source.path)?;
    Ok(())
}

pub fn cleanup(state: &FileState, session_id: &str) -> Result<(), String> {
    let mut temps = state
        .temps
        .lock()
        .map_err(|_| "文件状态锁已损坏".to_string())?;
    let ids: Vec<String> = temps
        .iter()
        .filter(|(_, record)| {
            record.session_id == session_id
                || record.session_id.starts_with(&format!("{session_id}-"))
        })
        .map(|(id, _)| id.clone())
        .collect();
    let mut errors = Vec::new();
    for id in ids {
        if let Some(record) = temps.remove(&id) {
            if record.path.exists() {
                if let Err(error) = fs::remove_file(&record.path) {
                    errors.push(format!("{}: {error}", record.path.display()));
                }
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("清理临时文件失败: {}", errors.join(", ")))
    }
}

/// 窗口退出或异常恢复时删除当前进程留下的所有临时文件。
pub fn cleanup_all(state: &FileState) -> Result<(), String> {
    let mut temps = state
        .temps
        .lock()
        .map_err(|_| "文件状态锁已损坏".to_string())?;
    let records: Vec<TempRecord> = temps.drain().map(|(_, record)| record).collect();
    let mut errors = Vec::new();
    for record in records {
        if record.path.exists() {
            if let Err(error) = fs::remove_file(&record.path) {
                errors.push(format!("{}: {error}", record.path.display()));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("清理临时文件失败: {}", errors.join(", ")))
    }
}

fn atomic_replace(temp: &Path, source: &Path) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        fs::rename(temp, source).map_err(|error| format!("原子替换原图失败: {error}"))
    }
    #[cfg(windows)]
    {
        let backup = source.with_extension("tinypng-backup");
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| format!("清理旧备份失败: {error}"))?;
        }
        fs::rename(source, &backup).map_err(|error| format!("准备覆盖原图失败: {error}"))?;
        match fs::rename(temp, source) {
            Ok(()) => {
                let _ = fs::remove_file(backup);
                Ok(())
            }
            Err(error) => {
                let _ = fs::rename(&backup, source);
                Err(format!("原子替换原图失败: {error}"))
            }
        }
    }
}

fn clean_extension(extension: &str) -> Result<String, String> {
    let cleaned: String = extension
        .trim_start_matches('.')
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    if cleaned.is_empty() {
        return Err("输出文件扩展名无效".to_string());
    }
    Ok(if cleaned == "jpeg" {
        "jpg".to_string()
    } else {
        cleaned
    })
}

fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            let normalized = extension.to_ascii_lowercase();
            SUPPORTED_EXTENSIONS
                .iter()
                .any(|supported| *supported == normalized)
        })
        .unwrap_or(false)
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
    .to_string()
}
