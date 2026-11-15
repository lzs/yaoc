//! Remember normal window geometry separately from maximized/minimized geometry.
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{Manager, PhysicalPosition, PhysicalSize, Window};

/// Minimum client size in logical pixels; must match `minWidth`/`minHeight` in tauri.conf.json.
const MIN_WIDTH: f64 = 800.0;
const MIN_HEIGHT: f64 = 620.0;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Placement {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    frame_width: u32,
    frame_height: u32,
    scale: f64,
    maximized: bool,
}

#[derive(Default)]
pub struct WindowState {
    ready: AtomicBool,
    placement: Mutex<Option<Placement>>,
    /// The workspace drawer's share of the window width while it is open, so
    /// closing the drawer gives that width back. Logical pixels.
    expansion: Mutex<Option<Expansion>>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Expansion {
    /// Width the drawer currently adds to the window. Starts as the amount the
    /// window grew; follows later drawer resizes (divider or window edge).
    added: f64,
    /// Part of the drawer that did not fit when it opened and narrowed the chat.
    squeezed: f64,
    /// How far the window moved left to make room.
    shifted: f64,
}

impl Expansion {
    fn follow(&mut self, drawer_width: f64) {
        self.added = (drawer_width - self.squeezed).max(0.0);
    }
}

/// What the page is telling the window about the workspace drawer.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DrawerChange {
    /// The drawer just opened at this width: widen the window for it.
    Open,
    /// The open drawer changed width: only remember it, never resize.
    Resize,
    /// The drawer closed: give back the width it currently adds.
    Close,
}

#[derive(Clone, Copy)]
struct WorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}

impl Placement {
    fn valid(&self) -> bool {
        self.width > 0
            && self.height > 0
            && self.width <= 100_000
            && self.height <= 100_000
            && self.frame_width <= 1_000
            && self.frame_height <= 1_000
            && self.scale.is_finite()
            && (0.25..=8.0).contains(&self.scale)
    }

    fn intersection(&self, area: WorkArea) -> i64 {
        let width = (i64::from(self.x) + i64::from(self.width) + i64::from(self.frame_width))
            .min(i64::from(area.x) + i64::from(area.width))
            - i64::from(self.x).max(i64::from(area.x));
        let height = (i64::from(self.y) + i64::from(self.height) + i64::from(self.frame_height))
            .min(i64::from(area.y) + i64::from(area.height))
            - i64::from(self.y).max(i64::from(area.y));
        width.max(0) * height.max(0)
    }

    fn fit(&mut self, area: WorkArea) {
        let ratio = area.scale / self.scale;
        self.frame_width = (f64::from(self.frame_width) * ratio).round() as u32;
        self.frame_height = (f64::from(self.frame_height) * ratio).round() as u32;
        // Preserve logical size on a display with a different DPI, subject to the
        // configured minimum size and the available desktop work area.
        self.width = ((f64::from(self.width) * ratio).round() as u32)
            .min(area.width.saturating_sub(self.frame_width))
            .max((MIN_WIDTH * area.scale).round() as u32);
        self.height = ((f64::from(self.height) * ratio).round() as u32)
            .min(area.height.saturating_sub(self.frame_height))
            .max((MIN_HEIGHT * area.scale).round() as u32);
        let right = i64::from(area.x) + i64::from(area.width)
            - i64::from(self.width)
            - i64::from(self.frame_width);
        let bottom = i64::from(area.y) + i64::from(area.height)
            - i64::from(self.height)
            - i64::from(self.frame_height);
        self.x = i64::from(self.x).clamp(i64::from(area.x), right.max(i64::from(area.x))) as i32;
        self.y = i64::from(self.y).clamp(i64::from(area.y), bottom.max(i64::from(area.y))) as i32;
        self.scale = area.scale;
    }
}

pub fn restore(window: &Window) -> Result<(), Box<dyn std::error::Error>> {
    let state = window.state::<WindowState>();
    let path = super::get_storage_dir()?.join("window-state.json");
    let result = (|| {
        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        let mut placement: Placement = serde_json::from_str(&raw)?;
        if !placement.valid() {
            return Err("Invalid saved window geometry".into());
        }
        let mut monitors = window.available_monitors()?;
        // Primary monitor is the fallback when the saved display is disconnected.
        if let Some(primary) = window.primary_monitor()? {
            monitors.insert(0, primary);
        }
        let areas: Vec<_> = monitors
            .iter()
            .map(|monitor| {
                let work = monitor.work_area();
                WorkArea {
                    x: work.position.x,
                    y: work.position.y,
                    width: work.size.width,
                    height: work.size.height,
                    scale: monitor.scale_factor(),
                }
            })
            .collect();
        if let Some(area) = areas
            .iter()
            .max_by_key(|area| placement.intersection(**area))
        {
            let area = if placement.intersection(*area) == 0 {
                areas[0]
            } else {
                *area
            };
            placement.fit(area);
            // Keep the normal bounds before maximizing, so restoring down works
            // after relaunching a previously maximized window.
            *state.placement.lock().unwrap() = Some(placement.clone());
            window.set_position(PhysicalPosition::new(placement.x, placement.y))?;
            window.set_size(PhysicalSize::new(placement.width, placement.height))?;
            if placement.maximized {
                window.maximize()?;
            }
        }
        Ok(())
    })();
    state.ready.store(true, Ordering::Release);
    track(window);
    result
}

pub fn track(window: &Window) {
    let Some(state) = window.try_state::<WindowState>() else {
        return;
    };
    if !state.ready.load(Ordering::Acquire) || window.is_minimized().unwrap_or(true) {
        return;
    }
    let Ok(maximized) = is_maximized(window) else {
        return;
    };
    if maximized {
        if let Some(placement) = state.placement.lock().unwrap().as_mut() {
            placement.maximized = true;
        }
        return;
    }
    if let (Ok(position), Ok(inner), Ok(outer), Ok(scale)) = (
        window.outer_position(),
        window.inner_size(),
        window.outer_size(),
        window.scale_factor(),
    ) {
        let placement = Placement {
            x: position.x,
            y: position.y,
            width: inner.width,
            height: inner.height,
            frame_width: outer.width.saturating_sub(inner.width),
            frame_height: outer.height.saturating_sub(inner.height),
            scale,
            maximized,
        };
        if placement.valid() {
            *state.placement.lock().unwrap() = Some(placement);
        }
    }
}

// Tao's cached maximized flag can lag behind move/resize events. Query the
// Windows style directly so transitional maximized bounds never replace the
// normal restore bounds.
pub(crate) fn is_maximized(window: &Window) -> tauri::Result<bool> {
    #[cfg(target_os = "windows")]
    {
        #[link(name = "user32")]
        extern "system" {
            fn IsZoomed(window: *mut std::ffi::c_void) -> i32;
        }
        Ok(unsafe { IsZoomed(window.hwnd()?.0) != 0 })
    }
    #[cfg(not(target_os = "windows"))]
    window.is_maximized()
}

pub fn save(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        track(&window.as_ref().window());
    }
    let state = app.state::<WindowState>();
    let placement = state.placement.lock().unwrap().clone();
    let expansion = *state.expansion.lock().unwrap();
    if let Some(mut placement) = placement {
        // Remember the size without the workspace widening; the page widens the
        // window again on the next launch if the workspace is still open.
        if let Some(expansion) = expansion {
            let added = (expansion.added * placement.scale).round() as u32;
            let shifted = (expansion.shifted * placement.scale).round() as i32;
            let min_width = (MIN_WIDTH * placement.scale).round() as u32;
            let width = placement.width.saturating_sub(added).max(min_width);
            if width < placement.width {
                placement.x = placement
                    .x
                    .saturating_add(shifted.min((placement.width - width) as i32));
                placement.width = width;
            }
        }
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            let dir = super::get_storage_dir()?;
            std::fs::create_dir_all(&dir)?;
            super::atomic_write(
                &dir.join("window-state.json"),
                &serde_json::to_string_pretty(&placement)?,
            )?;
            Ok(())
        })();
        if let Err(error) = result {
            super::log_boot(&format!("Could not save window state: {error}"));
        }
    }
}

/// Plans widening a window whose outer edges are `left`..`right` within a work
/// area `area_left`..`area_right` (all physical pixels). Grows to the right first,
/// then moves left for whatever does not fit. Returns (grow, shift_left).
fn plan_expansion(
    left: i64,
    right: i64,
    area_left: i64,
    area_right: i64,
    desired: i64,
) -> (i64, i64) {
    let room_right = (area_right - right).max(0);
    let room_left = (left - area_left).max(0);
    let grow = desired.min(room_right + room_left).max(0);
    (grow, (grow - room_right).max(0))
}

/// True while Windows Snap has arranged the window (half, quarter or layout).
fn is_arranged(window: &Window) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::c_void;
        #[link(name = "kernel32")]
        extern "system" {
            fn GetModuleHandleW(name: *const u16) -> *mut c_void;
            fn GetProcAddress(module: *mut c_void, name: *const std::ffi::c_char) -> *const c_void;
        }
        let Ok(hwnd) = window.hwnd() else {
            return false;
        };
        let name: Vec<u16> = "user32.dll\0".encode_utf16().collect();
        unsafe {
            let user32 = GetModuleHandleW(name.as_ptr());
            if user32.is_null() {
                return false;
            }
            // IsWindowArranged is only present on newer Windows 10/11 builds.
            let proc = GetProcAddress(user32, c"IsWindowArranged".as_ptr());
            if proc.is_null() {
                return false;
            }
            let is_window_arranged: extern "system" fn(*mut c_void) -> i32 =
                std::mem::transmute(proc);
            is_window_arranged(hwnd.0) != 0
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        false
    }
}

fn can_resize_for_workspace(window: &Window) -> bool {
    !window.is_minimized().unwrap_or(true)
        && !is_maximized(window).unwrap_or(true)
        && !window.is_fullscreen().unwrap_or(true)
        && !is_arranged(window)
}

/// Keeps the window in step with the workspace drawer (`width` is its logical
/// width including the drag handle). Opening widens the window so the chat keeps
/// its width; closing gives back whatever the drawer then adds. Returns how many
/// logical pixels the window grew (open) or shrank (close). Maximized,
/// full-screen, snapped and minimized windows are never resized.
pub fn set_workspace_expansion(
    window: &Window,
    change: DrawerChange,
    width: f64,
) -> tauri::Result<f64> {
    let state = window.state::<WindowState>();
    let mut current = state.expansion.lock().unwrap();
    let width = if width.is_finite() {
        width.max(0.0)
    } else {
        0.0
    };
    match change {
        DrawerChange::Resize => {
            if let Some(expansion) = current.as_mut() {
                expansion.follow(width);
            }
            Ok(0.0)
        }
        DrawerChange::Open => {
            if let Some(expansion) = current.as_mut() {
                expansion.follow(width);
                return Ok(0.0);
            }
            if width <= 0.0 || !can_resize_for_workspace(window) {
                return Ok(0.0);
            }
            let Some(monitor) = window.current_monitor()? else {
                return Ok(0.0);
            };
            let scale = window.scale_factor()?;
            let position = window.outer_position()?;
            let outer = window.outer_size()?;
            let inner = window.inner_size()?;
            let work = monitor.work_area();
            let left = i64::from(position.x);
            let (grow, shift) = plan_expansion(
                left,
                left + i64::from(outer.width),
                i64::from(work.position.x),
                i64::from(work.position.x) + i64::from(work.size.width),
                (width * scale).round() as i64,
            );
            if grow <= 0 {
                return Ok(0.0);
            }
            let grew = grow as f64 / scale;
            *current = Some(Expansion {
                added: grew,
                squeezed: (width - grew).max(0.0),
                shifted: shift as f64 / scale,
            });
            if shift > 0 {
                window.set_position(PhysicalPosition::new((left - shift) as i32, position.y))?;
            }
            window.set_size(PhysicalSize::new(inner.width + grow as u32, inner.height))?;
            Ok(grew)
        }
        DrawerChange::Close => {
            let Some(expansion) = current.take() else {
                return Ok(0.0);
            };
            if !can_resize_for_workspace(window) {
                return Ok(0.0);
            }
            let scale = window.scale_factor()?;
            let inner = window.inner_size()?;
            let position = window.outer_position()?;
            let min_width = (MIN_WIDTH * scale).round() as u32;
            let added = (expansion.added * scale).round() as u32;
            let new_width = inner
                .width
                .saturating_sub(added)
                .max(min_width)
                .min(inner.width);
            let shrunk = i64::from(inner.width - new_width);
            let shift = ((expansion.shifted * scale).round() as i64).min(shrunk);
            window.set_size(PhysicalSize::new(new_width, inner.height))?;
            if shift > 0 {
                window.set_position(PhysicalPosition::new(
                    (i64::from(position.x) + shift) as i32,
                    position.y,
                ))?;
            }
            Ok(shrunk as f64 / scale)
        }
    }
}

#[tauri::command]
pub fn set_workspace_window_expansion(
    window: tauri::WebviewWindow,
    change: DrawerChange,
    width: f64,
) -> Result<f64, String> {
    set_workspace_expansion(&window.as_ref().window(), change, width).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimum_size_matches_the_tauri_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let window = &config["app"]["windows"][0];
        assert_eq!(window["minWidth"].as_f64(), Some(MIN_WIDTH));
        assert_eq!(window["minHeight"].as_f64(), Some(MIN_HEIGHT));
    }

    #[test]
    fn drawer_resizes_change_what_closing_gives_back() {
        // Opened at 805 but only 600 fitted: the chat absorbed 205.
        let mut expansion = Expansion {
            added: 600.0,
            squeezed: 205.0,
            shifted: 0.0,
        };
        // Window edge dragged out by 200: the drawer took it all.
        expansion.follow(1005.0);
        assert_eq!(expansion.added, 800.0);
        // Divider dragged so the drawer is narrower than the squeezed part.
        expansion.follow(150.0);
        assert_eq!(expansion.added, 0.0);
        let change: DrawerChange = serde_json::from_str("\"resize\"").unwrap();
        assert_eq!(change, DrawerChange::Resize);
    }

    #[test]
    fn expansion_grows_right_then_moves_left_within_the_work_area() {
        // Plenty of room on the right.
        assert_eq!(plan_expansion(100, 1100, 0, 2560, 560), (560, 0));
        // Only 200 px on the right: move left by the rest.
        assert_eq!(plan_expansion(1000, 2360, 0, 2560, 560), (560, 360));
        // Not enough room anywhere: take what fits.
        assert_eq!(plan_expansion(50, 1850, 0, 1920, 560), (120, 50));
        // Already overflowing the right edge and flush left: nothing to give.
        assert_eq!(plan_expansion(0, 2000, 0, 1920, 560), (0, 0));
        // Secondary monitor to the left of the primary (negative coordinates).
        assert_eq!(plan_expansion(-1800, -400, -1920, 0, 560), (520, 120));
    }
    fn placement() -> Placement {
        Placement {
            x: 200,
            y: 100,
            width: 1360,
            height: 860,
            frame_width: 16,
            frame_height: 39,
            scale: 1.0,
            maximized: true,
        }
    }
    #[test]
    fn disconnected_monitor_and_smaller_work_area_remain_reachable() {
        let mut saved = placement();
        saved.x = 4000;
        saved.y = -2000;
        saved.fit(WorkArea {
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
            scale: 1.0,
        });
        assert_eq!(
            (saved.x, saved.y, saved.width, saved.height),
            (0, 0, 1264, 681)
        );
        assert!(saved.maximized);
    }
    #[test]
    fn negative_monitor_coordinates_and_dpi_changes_are_supported() {
        let mut saved = placement();
        saved.x = -1800;
        let area = WorkArea {
            x: -2560,
            y: 0,
            width: 2560,
            height: 1440,
            scale: 1.5,
        };
        assert!(saved.intersection(area) > 0);
        saved.fit(area);
        assert_eq!((saved.width, saved.height, saved.scale), (2040, 1290, 1.5));
        assert!(saved.x >= -2560 && saved.x + saved.width as i32 + saved.frame_width as i32 <= 0);
    }
    #[test]
    fn corrupt_or_empty_sizes_are_rejected_and_extreme_positions_do_not_overflow() {
        let mut saved = placement();
        saved.width = 0;
        assert!(!saved.valid());
        saved.width = 1360;
        saved.x = i32::MAX;
        saved.y = i32::MIN;
        assert_eq!(
            saved.intersection(WorkArea {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
                scale: 1.0
            }),
            0
        );
        let decoded: Placement =
            serde_json::from_str(&serde_json::to_string(&saved).unwrap()).unwrap();
        assert!(decoded.valid());
        assert_eq!(decoded.x, i32::MAX);
    }
}
