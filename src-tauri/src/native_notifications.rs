//! Native Windows toasts for standalone copies, under a separate per-user identity.
//! Registry-only registration follows tauri-winrt-notification's unpackaged_app example.
use crate::distribution::{self, Mode};
use std::{fs, path::Path};
use tauri::{AppHandle, Manager};
use tauri_winrt_notification::Toast;
use windows_registry::CURRENT_USER;

pub const PORTABLE_ID: &str = "io.github.lzs.yaoc.portable";
const INSTALLED_ID: &str = "io.github.lzs.yaoc";
const REGISTRY_PATH: &str = r"Software\Classes\AppUserModelId\io.github.lzs.yaoc.portable";
const ICON: &[u8] = include_bytes!("../icons/128x128.png");

fn register_portable(icon: &Path) -> Result<(), String> {
    // The icon lives in shared AppData, not next to an executable that can move.
    let parent = icon
        .parent()
        .ok_or("Portable notification icon directory is missing")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    if fs::read(icon).ok().as_deref() != Some(ICON) {
        fs::write(icon, ICON).map_err(|e| e.to_string())?;
    }
    let key = CURRENT_USER
        .create(REGISTRY_PATH)
        .map_err(|e| e.to_string())?;
    key.set_string("DisplayName", "YAOC Portable")
        .map_err(|e| e.to_string())?;
    key.set_string("IconBackgroundColor", "0")
        .map_err(|e| e.to_string())?;
    key.set_hstring("IconUri", &icon.into())
        .map_err(|e| e.to_string())
}

pub fn initialize() -> Result<(), String> {
    let distribution = distribution::current();
    let id = if distribution.mode == Mode::Portable {
        register_portable(
            &distribution
                .webview_directory
                .join("notifications")
                .join("portable.png"),
        )?;
        PORTABLE_ID
    } else {
        INSTALLED_ID
    };
    #[link(name = "shell32")]
    extern "system" {
        fn SetCurrentProcessExplicitAppUserModelID(app_id: *const u16) -> i32;
    }
    let wide: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
    let result = unsafe { SetCurrentProcessExplicitAppUserModelID(wide.as_ptr()) };
    if result < 0 {
        return Err(format!(
            "Could not select Windows notification identity: {result:#x}"
        ));
    }
    Ok(())
}

pub fn show_portable(app: AppHandle, title: &str, body: &str) -> Result<(), String> {
    // Repair registration/icon after a manual cleanup without touching the installed identity.
    register_portable(
        &distribution::current()
            .webview_directory
            .join("notifications")
            .join("portable.png"),
    )?;
    Toast::new(PORTABLE_ID)
        .title(title)
        .text1(body)
        // YAOC already plays its configurable chime; avoid a second Windows sound.
        .sound(None)
        .on_activated(move |_| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            Ok(())
        })
        .show()
        .map_err(|e| format!("Could not show portable Windows notification: {e}"))
}
