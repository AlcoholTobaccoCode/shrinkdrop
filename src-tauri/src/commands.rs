use crate::compression::{self, CompressionResult, CompressionState};
use crate::file_ops::{self, BatchSaveResult, FileDescriptor, FileState};
use crate::overwrite::{self, BatchOverwriteResult, OriginalTarget};
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};

//#region 原生导入与受控读取
const IMPORT_EMPTY_ERROR: &str =
    "没有可导入的图片，请确认文件可读、格式为 PNG/JPG/WebP，单张不超过 20 MB";

fn finish_file_selection(
    files: Vec<FileDescriptor>,
    selected: bool,
) -> Result<Vec<FileDescriptor>, String> {
    if selected && files.is_empty() {
        Err(IMPORT_EMPTY_ERROR.into())
    } else {
        Ok(files)
    }
}

#[tauri::command]
pub async fn choose_files<R: tauri::Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<FileDescriptor>, String> {
    // 原生对话框放入阻塞线程，避免主线程事件循环卡住。
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<FileState>();
        let selected = app
            .dialog()
            .file()
            .add_filter("图片", &["png", "jpg", "jpeg", "webp"])
            .blocking_pick_files();
        let mut all = Vec::new();
        let selected = selected.unwrap_or_default();
        let has_selection = !selected.is_empty();
        for file in selected {
            let path = file
                .into_path()
                .map_err(|_| IMPORT_EMPTY_ERROR.to_string())?;
            all.extend(
                file_ops::collect_files(&state, &path, false)
                    .map_err(|_| IMPORT_EMPTY_ERROR.to_string())?,
            );
        }
        finish_file_selection(all, has_selection)
    })
    .await
    .map_err(|_| "选择图片失败，请重试".to_string())?
}

#[tauri::command]
pub async fn choose_directory<R: tauri::Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<FileDescriptor>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<FileState>();
        let Some(folder) = app.dialog().file().blocking_pick_folder() else {
            return Ok(Vec::new());
        };
        let path = folder
            .into_path()
            .map_err(|_| IMPORT_EMPTY_ERROR.to_string())?;
        finish_file_selection(
            file_ops::collect_files(&state, Path::new(&path), true)
                .map_err(|_| IMPORT_EMPTY_ERROR.to_string())?,
            true,
        )
    })
    .await
    .map_err(|_| "选择文件夹失败，请重试".to_string())?
}

#[tauri::command]
pub async fn read_file<R: tauri::Runtime>(
    app: AppHandle<R>,
    source_id: String,
) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        file_ops::read_source(&app.state::<FileState>(), &source_id)
    })
    .await
    .map_err(|_| "读取图片失败，请重试".to_string())?
}
//#endregion

//#region 匿名压缩与会话取消
#[tauri::command]
pub async fn compress_image<R: tauri::Runtime>(
    app: AppHandle<R>,
    source_id: String,
    task_id: String,
) -> Result<CompressionResult, String> {
    compression::compress(app, source_id, task_id).await
}

#[tauri::command]
pub fn cancel_compression(
    state: State<'_, CompressionState>,
    files: State<'_, FileState>,
    task_id: String,
) -> Result<(), String> {
    state.cancel(&task_id)?;
    file_ops::cleanup(&files, &task_id)
}

#[tauri::command]
pub fn cleanup_temp_files(
    state: State<'_, CompressionState>,
    files: State<'_, FileState>,
    session_id: String,
) -> Result<(), String> {
    state.cancel_session(&session_id)?;
    file_ops::cleanup(&files, &session_id)
}
//#endregion

//#region 保存压缩副本
#[derive(Serialize)]
pub struct SaveResult {
    saved: bool,
}

fn save_dialog_name(metadata: &FileDescriptor, _suggested_name: &str) -> Result<String, String> {
    // 使用已登记的压缩副本名，保留前端参数兼容但不把原图名作为保存默认值。
    let name = metadata
        .name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_string();
    if name.is_empty() || name == "." || name == ".." || name.chars().any(char::is_control) {
        return Err("保存文件名无效".into());
    }
    Ok(name)
}

#[tauri::command]
pub async fn save_temp_file<R: tauri::Runtime>(
    app: AppHandle<R>,
    temp_file_id: String,
    suggested_name: String,
) -> Result<SaveResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<FileState>();
        let metadata = state
            .temps
            .lock()
            .map_err(|_| "文件状态不可用".to_string())?
            .get(&temp_file_id)
            .map(|record| record.metadata.clone())
            .ok_or_else(|| "压缩结果已失效，请重新处理".to_string())?;
        let name = save_dialog_name(&metadata, &suggested_name)?;
        let extension = match metadata.mime.as_str() {
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            _ => "png",
        };
        let save_dir = app
            .state::<crate::settings::SettingsState>()
            .get()
            .compression
            .save_dir
            .filter(|value| !value.trim().is_empty());
        let dialog = app.dialog().file();
        let dialog = match save_dir {
            Some(directory) => dialog.set_directory(std::path::PathBuf::from(directory)),
            None => dialog,
        };
        let Some(selected) = dialog
            .set_file_name(&name)
            .add_filter("图片", &[extension])
            .blocking_save_file()
        else {
            return Ok(SaveResult { saved: false });
        };
        let destination = selected
            .into_path()
            .map_err(|_| "保存位置无效".to_string())?;
        file_ops::save_temp_to_path(&state, &temp_file_id, &destination)?;
        Ok(SaveResult { saved: true })
    })
    .await
    .map_err(|_| "保存失败，请重试".to_string())?
}

#[tauri::command]
pub async fn save_results<R: tauri::Runtime>(
    app: AppHandle<R>,
    temp_file_ids: Vec<String>,
) -> Result<BatchSaveResult, String> {
    if temp_file_ids.is_empty() {
        return Ok(BatchSaveResult {
            saved: 0,
            failed: Vec::new(),
            canceled: false,
        });
    }
    tauri::async_runtime::spawn_blocking(move || {
        let save_dir = app
            .state::<crate::settings::SettingsState>()
            .get()
            .compression
            .save_dir
            .filter(|value| !value.trim().is_empty());
        let dialog = app.dialog().file();
        let dialog = match save_dir {
            Some(directory) => dialog.set_directory(std::path::PathBuf::from(directory)),
            None => dialog,
        };
        let Some(selected) = dialog.blocking_pick_folder() else {
            return Ok(BatchSaveResult {
                saved: 0,
                failed: Vec::new(),
                canceled: true,
            });
        };
        let directory = selected
            .into_path()
            .map_err(|_| "保存目录无效".to_string())?;
        Ok(file_ops::save_to_directory(
            &app.state::<FileState>(),
            &temp_file_ids,
            &directory,
        ))
    })
    .await
    .map_err(|_| "批量保存失败，请重试".to_string())?
}
//#endregion

//#region 确认覆盖原图
fn confirm_overwrite<R: tauri::Runtime>(app: &AppHandle<R>, targets: &[OriginalTarget]) -> bool {
    let message = if targets.len() == 1 {
        format!(
            "将用压缩结果替换以下原图：\n{}\n\n此操作无法撤销。",
            targets[0].path.display()
        )
    } else {
        format!(
            "将用压缩结果覆盖 {} 张原图，分别写回各自的原始位置。\n\n此操作无法撤销。",
            targets.len()
        )
    };
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    app.dialog()
        .message(message)
        .parent(&window)
        .title(if targets.len() == 1 {
            "覆盖原图？"
        } else {
            "批量覆盖原图？"
        })
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "覆盖原图".into(),
            "取消".into(),
        ))
        .blocking_show()
}

#[derive(Serialize)]
pub struct OverwriteResult {
    overwritten: bool,
}

#[tauri::command]
pub async fn overwrite_temp_file<R: tauri::Runtime>(
    app: AppHandle<R>,
    temp_file_id: String,
) -> Result<OverwriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result =
            overwrite::overwrite_results(&app.state::<FileState>(), &[temp_file_id], |targets| {
                confirm_overwrite(&app, targets)
            })?;
        if let Some(failure) = result.failed.first() {
            return Err(failure.message.clone());
        }
        Ok(OverwriteResult {
            overwritten: !result.canceled && result.overwritten == 1,
        })
    })
    .await
    .map_err(|_| "覆盖失败，请重试".to_string())?
}

#[tauri::command]
pub async fn overwrite_results<R: tauri::Runtime>(
    app: AppHandle<R>,
    temp_file_ids: Vec<String>,
) -> Result<BatchOverwriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        overwrite::overwrite_results(&app.state::<FileState>(), &temp_file_ids, |targets| {
            confirm_overwrite(&app, targets)
        })
    })
    .await
    .map_err(|_| "批量覆盖失败，请重试".to_string())?
}
//#endregion

#[cfg(test)]
mod save_tests {
    use super::*;

    #[test]
    fn save_dialog_defaults_to_registered_compressed_name() {
        let result = FileDescriptor {
            id: "temp-1".into(),
            name: "photo.min.png".into(),
            size: 12,
            mime: "image/png".into(),
            relative_path: "photo.png".into(),
            last_modified: None,
            handle: Some("temp-1".into()),
        };
        assert_eq!(
            save_dialog_name(&result, "photo.png").unwrap(),
            "photo.min.png"
        );
        assert_eq!(save_dialog_name(&result, "").unwrap(), "photo.min.png");
    }

    #[test]
    fn choosing_without_registered_images_has_clear_feedback() {
        assert!(finish_file_selection(Vec::new(), false).unwrap().is_empty());
        assert_eq!(
            finish_file_selection(Vec::new(), true).unwrap_err(),
            IMPORT_EMPTY_ERROR
        );
    }
}
