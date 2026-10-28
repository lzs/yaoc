//! Narrow window-control IPC for the integrated application title bar.
use serde::Deserialize;
use tauri::Window;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowAction {
    Minimize,
    ToggleMaximize,
    Close,
    StartDragging,
}

#[tauri::command]
pub fn window_action(window: Window, action: WindowAction) -> Result<(), String> {
    let result = match action {
        WindowAction::Minimize => window.minimize(),
        WindowAction::ToggleMaximize => {
            if crate::window_state::is_maximized(&window).map_err(|error| error.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        // Route through CloseRequested so close-to-tray and geometry saving still run.
        WindowAction::Close => window.close(),
        WindowAction::StartDragging => window.start_dragging(),
    };
    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_window_maximized(window: Window) -> Result<bool, String> {
    crate::window_state::is_maximized(&window).map_err(|error| error.to_string())
}
