//! Remember normal window geometry separately from maximized/minimized geometry.
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{Manager, PhysicalPosition, PhysicalSize, Window};

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
            .max((960.0 * area.scale).round() as u32);
        self.height = ((f64::from(self.height) * ratio).round() as u32)
            .min(area.height.saturating_sub(self.frame_height))
            .max((620.0 * area.scale).round() as u32);
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
fn is_maximized(window: &Window) -> tauri::Result<bool> {
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
    let placement = app.state::<WindowState>().placement.lock().unwrap().clone();
    if let Some(placement) = placement {
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

#[cfg(test)]
mod tests {
    use super::*;
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
