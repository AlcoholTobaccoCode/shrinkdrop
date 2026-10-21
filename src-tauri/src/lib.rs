use tauri::{Emitter, Manager};

mod commands;
mod compression;
mod file_ops;
mod overwrite;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(file_ops::FileState::default())
        .manage(compression::CompressionState::default())
        .on_window_event(|window, event| {
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
            commands::overwrite_results
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
