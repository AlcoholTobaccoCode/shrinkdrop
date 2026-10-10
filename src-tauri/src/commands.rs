use crate::file_ops::{self, FileDescriptor, FileState};
use std::path::Path;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub fn choose_files<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, FileState>,
) -> Result<Vec<FileDescriptor>, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter("图片", &["png", "jpg", "jpeg", "webp"])
        .blocking_pick_files();
    let files = selected.unwrap_or_default();
    let mut all = Vec::new();
    for file in files {
        let path = file
            .into_path()
            .map_err(|error| format!("无法读取选择的文件: {error}"))?;
        all.extend(file_ops::collect_files(&state, &path, false)?);
    }
    Ok(all)
}

#[tauri::command]
pub fn choose_directory<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, FileState>,
) -> Result<Vec<FileDescriptor>, String> {
    let selected = app.dialog().file().blocking_pick_folder();
    let Some(folder) = selected else {
        return Ok(Vec::new());
    };
    let path = folder
        .into_path()
        .map_err(|error| format!("无法读取选择的目录: {error}"))?;
    file_ops::collect_files(&state, Path::new(&path), true)
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
