//! "Save a copy" for workspace files: a native Save As dialog, then a plain UTF-8 write.
//! Uses comdlg32 directly (no extra crates); on Windows 10/11 it shows the modern dialog.

/// Turns a workspace path into a safe default file name for the dialog.
fn suggested_name(workspace_path: &str) -> String {
    let base = workspace_path.rsplit(['/', '\\']).next().unwrap_or_default();
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
        "workspace-file.txt".into()
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
    let name = suggested_name(&file_name);
    #[cfg(windows)]
    {
        let owner = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
        let picked = tauri::async_runtime::spawn_blocking(move || dialog::pick_save_path(owner, &name))
            .await
            .map_err(|e| e.to_string())??;
        let Some(path) = picked else {
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

    /// Shows the dialog modally over `owner`. `Ok(None)` means the user cancelled.
    pub fn pick_save_path(owner: isize, suggested: &str) -> Result<Option<PathBuf>, String> {
        // The shell dialog needs a single-threaded apartment on this worker thread.
        let com = unsafe {
            CoInitializeEx(
                std::ptr::null(),
                COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE,
            )
        };
        let mut buffer = vec![0u16; MAX_PATH_CHARS];
        for (slot, unit) in buffer.iter_mut().zip(suggested.encode_utf16()) {
            *slot = unit;
        }
        let filter: Vec<u16> = "All files (*.*)\0*.*\0\0".encode_utf16().collect();
        let title = wide("Save a Copy");
        let extension = suggested
            .rsplit_once('.')
            .map(|(_, ext)| ext)
            .filter(|ext| !ext.is_empty());
        let default_ext = extension.map(wide);
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
            default_ext: default_ext.as_ref().map_or(std::ptr::null(), |e| e.as_ptr()),
            cust_data: 0,
            hook: std::ptr::null(),
            template_name: std::ptr::null(),
            reserved_ptr: std::ptr::null_mut(),
            reserved: 0,
            flags_ex: 0,
        };
        let accepted = unsafe { GetSaveFileNameW(&mut ofn) } != 0;
        let error = if accepted { 0 } else { unsafe { CommDlgExtendedError() } };
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
        Ok(Some(PathBuf::from(std::ffi::OsString::from_wide(
            &buffer[..len],
        ))))
    }
}

#[cfg(test)]
mod tests {
    use super::suggested_name;

    #[test]
    fn suggested_name_uses_the_base_name_and_strips_invalid_characters() {
        assert_eq!(suggested_name("docs/notes.md"), "notes.md");
        assert_eq!(suggested_name("a\\b\\c.txt"), "c.txt");
        assert_eq!(suggested_name("what?.md"), "what_.md");
        assert_eq!(suggested_name("trailing. "), "trailing");
        assert_eq!(suggested_name("docs/"), "workspace-file.txt");
    }
}
