use tauri::{Emitter, Manager};

mod commands;
mod compression;
mod file_ops;
mod overwrite;
mod settings;
mod share;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(file_ops::FileState::default())
        .manage(compression::CompressionState::default())
        .manage(share::ShareManager::default())
        .manage(settings::SettingsState::default())
        .setup(|app| {
            let loaded = settings::load(&app.handle());
            app.state::<settings::SettingsState>().replace(loaded);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let paths = paths.clone();
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let state = app.state::<file_ops::FileState>();
                    let mut descriptors = Vec::new();
                    for path in paths {
                        if let Ok(files) = file_ops::collect_files(&state, &path, path.is_dir()) {
                            descriptors.extend(files);
                        }
                    }
                    let _ = app.emit("lite-files-imported", descriptors);
                });
            }
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                window.state::<compression::CompressionState>().cancel_all();
                let _ = file_ops::cleanup_all(&window.state::<file_ops::FileState>());
                window.state::<share::ShareManager>().shutdown_now();
                if let Some(settings) = window.app_handle().get_webview_window("settings") {
                    let _ = settings.close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::choose_files,
            commands::choose_directory,
            commands::read_file,
            commands::compress_image,
            commands::cancel_compression,
            commands::cleanup_temp_files,
            commands::save_temp_file,
            commands::save_results,
            commands::overwrite_temp_file,
            commands::overwrite_results,
            share::share_start,
            share::share_stop,
            share::share_status,
            share::share_add_items,
            share::share_remove_item,
            share::share_pick_files,
            share::share_pick_directory,
            share::share_qr_svg,
            share::share_set_title,
            share::share_add_text,
            settings::settings_get,
            settings::settings_update,
            settings::settings_touch_face,
            settings::settings_pick_directory,
            settings::settings_open,
            settings::share_set_pin,
            settings::share_add_account,
            settings::share_update_account,
            settings::share_delete_account,
            settings::share_group_add,
            settings::share_group_update,
            settings::share_group_delete,
            settings::share_group_access,
            settings::share_group_set_pin,
            share::share_set_active_group,
            share::share_open_upload_dir
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
