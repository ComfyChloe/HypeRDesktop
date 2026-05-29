use tauri::{LogicalSize, WebviewWindow};

#[tauri::command]
pub fn resize_window(window: WebviewWindow, width: u32, height: u32) -> Result<(), String> {
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_window(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}
