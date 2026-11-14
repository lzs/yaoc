//! Native Save As for "Save a copy" (workspace files) and conversation exports,
//! followed by a plain UTF-8 write. Uses comdlg32 directly (no extra crates); on
//! Windows 10/11 it shows the modern dialog.

/// Turns a workspace path into a safe default file name for the dialog.
fn suggested_name(workspace_path: &str, fallback: &str) -> String {
    let base = workspace_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default();
    let cleaned: String = base
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim_end_matches(['.', ' ']).trim();
    if cleaned.is_empty() {
        fallback.into()
    } else {
        cleaned.into()
    }
}

#[tauri::command]
pub async fn save_file_copy(
    window: tauri::WebviewWindow,
    file_name: String,
    content: String,
) -> Result<Option<String>, String> {
    let name = suggested_name(&file_name, "workspace-file.txt");
    #[cfg(windows)]
    {
        let owner = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
        let picked = tauri::async_runtime::spawn_blocking(move || {
            dialog::pick_save_path(
                owner,
                &dialog::SaveDialog {
                    title: "Save a Copy",
                    filter: "All files (*.*)\0*.*\0",
                    suggested: &name,
                    default_ext: name.rsplit_once('.').map(|(_, ext)| ext),
                },
            )
        })
        .await
        .map_err(|e| e.to_string())??;
        let Some((path, _)) = picked else {
            return Ok(None);
        };
        std::fs::write(&path, content.as_bytes())
            .map_err(|e| format!("Could not write {}: {e}", path.display()))?;
        Ok(Some(path.display().to_string()))
    }
    #[cfg(not(windows))]
    {
        let _ = (window, name, content);
        Err("Saving a copy is only available on Windows.".into())
    }
}

/// Which format an export should be written in, from the chosen path and file type.
fn export_wants_html(path: &std::path::Path, filter_index: u32) -> bool {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("html" | "htm") => true,
        Some("md" | "markdown" | "txt") => false,
        _ => filter_index == 2,
    }
}

/// Exports a conversation. The page sends both renderings; the Save As file type
/// (or the typed extension) decides which one is written.
#[tauri::command]
pub async fn export_transcript(
    window: tauri::WebviewWindow,
    file_name: String,
    markdown: String,
    html: String,
) -> Result<Option<String>, String> {
    let base = suggested_name(&file_name, "conversation");
    #[cfg(windows)]
    {
        let owner = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
        let suggested = format!("{base}.md");
        let picked = tauri::async_runtime::spawn_blocking(move || {
            dialog::pick_save_path(
                owner,
                &dialog::SaveDialog {
                    title: "Export Conversation",
                    filter: "Markdown (*.md)\0*.md\0HTML page (*.html)\0*.html\0",
                    suggested: &suggested,
                    default_ext: Some("md"),
                },
            )
        })
        .await
        .map_err(|e| e.to_string())??;
        let Some((path, filter_index)) = picked else {
            return Ok(None);
        };
        let content = if export_wants_html(&path, filter_index) {
            html
        } else {
            markdown
        };
        std::fs::write(&path, content.as_bytes())
            .map_err(|e| format!("Could not write {}: {e}", path.display()))?;
        Ok(Some(path.display().to_string()))
    }
    #[cfg(not(windows))]
    {
        let _ = (window, base, markdown, html);
        Err("Exporting is only available on Windows.".into())
    }
}

#[cfg(windows)]
mod dialog {
    use std::{ffi::c_void, os::windows::ffi::OsStringExt, path::PathBuf};

    // OPENFILENAMEW with natural alignment (YAOC ships only 64-bit builds).
    #[repr(C)]
    struct OpenFileNameW {
        struct_size: u32,
        owner: isize,
        instance: isize,
        filter: *const u16,
        custom_filter: *mut u16,
        max_custom_filter: u32,
        filter_index: u32,
        file: *mut u16,
        max_file: u32,
        file_title: *mut u16,
        max_file_title: u32,
        initial_dir: *const u16,
        title: *const u16,
        flags: u32,
        file_offset: u16,
        file_extension: u16,
        default_ext: *const u16,
        cust_data: isize,
        hook: *const c_void,
        template_name: *const u16,
        reserved_ptr: *mut c_void,
        reserved: u32,
        flags_ex: u32,
    }

    #[link(name = "comdlg32")]
    extern "system" {
        fn GetSaveFileNameW(ofn: *mut OpenFileNameW) -> i32;
        fn CommDlgExtendedError() -> u32;
    }
    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(reserved: *const c_void, coinit: u32) -> i32;
        fn CoUninitialize();
    }

    const OFN_OVERWRITEPROMPT: u32 = 0x2;
    const OFN_HIDEREADONLY: u32 = 0x4;
    const OFN_NOCHANGEDIR: u32 = 0x8;
    const OFN_PATHMUSTEXIST: u32 = 0x800;
    const OFN_EXPLORER: u32 = 0x8_0000;
    const COINIT_APARTMENTTHREADED: u32 = 0x2;
    const COINIT_DISABLE_OLE1DDE: u32 = 0x4;
    const MAX_PATH_CHARS: usize = 32_768;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub struct SaveDialog<'a> {
        pub title: &'a str,
        /// Pairs of "label\0pattern\0"; the final terminator is added here.
        pub filter: &'a str,
        pub suggested: &'a str,
        pub default_ext: Option<&'a str>,
    }

    /// Shows the dialog modally over `owner`. Returns the chosen path and the
    /// 1-based index of the selected file type; `Ok(None)` means the user cancelled.
    pub fn pick_save_path(
        owner: isize,
        options: &SaveDialog<'_>,
    ) -> Result<Option<(PathBuf, u32)>, String> {
        // The shell dialog needs a single-threaded apartment on this worker thread.
        let com = unsafe {
            CoInitializeEx(
                std::ptr::null(),
                COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE,
            )
        };
        let mut buffer = vec![0u16; MAX_PATH_CHARS];
        for (slot, unit) in buffer.iter_mut().zip(options.suggested.encode_utf16()) {
            *slot = unit;
        }
        let filter = wide(options.filter);
        let title = wide(options.title);
        let default_ext = options.default_ext.filter(|ext| !ext.is_empty()).map(wide);
        let mut ofn = OpenFileNameW {
            struct_size: std::mem::size_of::<OpenFileNameW>() as u32,
            owner,
            instance: 0,
            filter: filter.as_ptr(),
            custom_filter: std::ptr::null_mut(),
            max_custom_filter: 0,
            filter_index: 1,
            file: buffer.as_mut_ptr(),
            max_file: MAX_PATH_CHARS as u32,
            file_title: std::ptr::null_mut(),
            max_file_title: 0,
            initial_dir: std::ptr::null(),
            title: title.as_ptr(),
            flags: OFN_OVERWRITEPROMPT
                | OFN_HIDEREADONLY
                | OFN_NOCHANGEDIR
                | OFN_PATHMUSTEXIST
                | OFN_EXPLORER,
            file_offset: 0,
            file_extension: 0,
            default_ext: default_ext
                .as_ref()
                .map_or(std::ptr::null(), |e| e.as_ptr()),
            cust_data: 0,
            hook: std::ptr::null(),
            template_name: std::ptr::null(),
            reserved_ptr: std::ptr::null_mut(),
            reserved: 0,
            flags_ex: 0,
        };
        let accepted = unsafe { GetSaveFileNameW(&mut ofn) } != 0;
        let error = if accepted {
            0
        } else {
            unsafe { CommDlgExtendedError() }
        };
        if com >= 0 {
            unsafe { CoUninitialize() };
        }
        if !accepted {
            return if error == 0 {
                Ok(None)
            } else {
                Err(format!("The Save dialog failed (error 0x{error:x})."))
            };
        }
        let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        let path = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..len]));
        Ok(Some((path, ofn.filter_index)))
    }
}

#[cfg(test)]
mod tests {
    use super::{export_wants_html, suggested_name};
    use std::path::Path;

    #[test]
    fn suggested_name_uses_the_base_name_and_strips_invalid_characters() {
        let name = |p| suggested_name(p, "workspace-file.txt");
        assert_eq!(name("docs/notes.md"), "notes.md");
        assert_eq!(name("a\\b\\c.txt"), "c.txt");
        assert_eq!(name("what?.md"), "what_.md");
        assert_eq!(name("trailing. "), "trailing");
        assert_eq!(name("docs/"), "workspace-file.txt");
    }

    #[test]
    fn export_format_follows_the_extension_then_the_file_type() {
        assert!(export_wants_html(Path::new("C:/x/chat.html"), 1));
        assert!(export_wants_html(Path::new("C:/x/chat.HTM"), 1));
        assert!(!export_wants_html(Path::new("C:/x/chat.md"), 2));
        assert!(export_wants_html(Path::new("C:/x/chat"), 2));
        assert!(!export_wants_html(Path::new("C:/x/chat.log"), 1));
    }
}
