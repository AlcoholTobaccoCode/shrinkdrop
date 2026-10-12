mod commands;
mod file_ops;
mod token;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(file_ops::FileState::default())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let _ = file_ops::cleanup_all(&window.state::<file_ops::FileState>());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::choose_files,
            commands::choose_directory,
            commands::read_file,
            commands::write_temp,
            commands::copy_temp_files,
            commands::replace_original,
            commands::cleanup_temp_files,
            token::token_get,
            token::token_set,
            token::token_clear
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
