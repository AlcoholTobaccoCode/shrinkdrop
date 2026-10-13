use crate::file_ops::{self, FileDescriptor, FileState};
use std::path::Path;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use serde::Serialize;

#[tauri::command]
pub async fn choose_files<R: tauri::Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<FileDescriptor>, String> {
    // 原生对话框必须在后台等待，否则会阻塞主线程事件循环。
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<FileState>();
        let selected = app.dialog().file().add_filter("图片", &["png", "jpg", "jpeg", "webp"])
            .blocking_pick_files();
        let mut all = Vec::new();
        for file in selected.unwrap_or_default() {
            let path = file.into_path().map_err(|error| format!("无法读取选择的文件: {error}"))?;
            all.extend(file_ops::collect_files(&state, &path, false)?);
        }
        Ok(all)
    }).await.map_err(|error| format!("选择图片失败: {error}"))?
}

#[tauri::command]
pub async fn choose_directory<R: tauri::Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<FileDescriptor>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<FileState>();
        let Some(folder) = app.dialog().file().blocking_pick_folder() else { return Ok(Vec::new()); };
        let path = folder.into_path().map_err(|error| format!("无法读取选择的目录: {error}"))?;
        file_ops::collect_files(&state, Path::new(&path), true)
    }).await.map_err(|error| format!("选择文件夹失败: {error}"))?
}

#[tauri::command]
pub fn read_file(state: State<'_, FileState>, source_id: String) -> Result<Vec<u8>, String> {
    file_ops::read_source(&state, &source_id)
}

#[tauri::command]
pub fn write_temp<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, FileState>,
    task_id: String,
    bytes: Vec<u8>,
    extension: String,
    mime: String,
) -> Result<FileDescriptor, String> {
    file_ops::write_temp(&app, &state, &task_id, &bytes, &extension, &mime)
}

#[tauri::command]
pub fn copy_temp_files(
    _state: State<'_, FileState>,
    temp_file_ids: Vec<String>,
) -> Result<(), String> {
    if temp_file_ids.is_empty() {
        return Err("没有可复制的压缩文件".to_string());
    }
    // 文件剪贴板是平台相关能力；先通过明确命令保留契约，待接入原生剪贴板插件后实现。
    Err("当前平台尚未启用文件剪贴板，请使用下载或覆盖原图".to_string())
}

#[tauri::command]
pub fn replace_original(
    state: State<'_, FileState>,
    temp_file_id: String,
    source_id: String,
) -> Result<(), String> {
    file_ops::replace_original(&state, &temp_file_id, &source_id)
}

#[tauri::command]
pub fn cleanup_temp_files(state: State<'_, FileState>, session_id: String) -> Result<(), String> {
    file_ops::cleanup(&state, &session_id)
}

//#region 保存下载结果
#[derive(Serialize)]
pub struct SaveResult { saved: bool }

#[tauri::command]
pub async fn save_temp_file<R: tauri::Runtime>(
    app: AppHandle<R>,
    temp_file_id: String,
    suggested_name: String,
) -> Result<SaveResult, String> {
    let name = suggested_name.rsplit(['/', '\\']).next().unwrap_or("").to_string();
    if name.is_empty() || name == "." || name == ".." || name.chars().any(char::is_control) {
        return Err("下载文件名无效".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<FileState>();
        let metadata = state.temps.lock().map_err(|_| "文件状态锁已损坏".to_string())?
            .get(&temp_file_id).map(|record| record.metadata.clone())
            .ok_or_else(|| "处理结果已失效，请重新处理".to_string())?;
        let mut dialog = app.dialog().file().set_file_name(&name);
        if metadata.mime == "application/zip" {
            dialog = dialog.add_filter("ZIP 压缩包", &["zip"]);
        } else {
            dialog = dialog.add_filter("图片", &["png", "jpg", "jpeg", "webp", "avif"]);
        }
        let Some(selected) = dialog.blocking_save_file() else { return Ok(SaveResult { saved: false }); };
        let destination = selected.into_path().map_err(|error| format!("保存位置无效: {error}"))?;
        file_ops::save_temp_to_path(&state, &temp_file_id, &destination)?;
        Ok(SaveResult { saved: true })
    }).await.map_err(|error| format!("下载保存失败: {error}"))?
}
//#endregion
