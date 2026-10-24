//! Background CPU scheduling for the native host. WebView2 and Gateway tasks stay live.

#[cfg(target_os = "windows")]
mod windows {
    use std::{ffi::c_void, io, mem::size_of, sync::Mutex};

    // Out-of-context WinEvents run on the installing thread, using its message loop.
    thread_local! {
        static FOREGROUND_CALLBACK: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> *mut c_void;
        fn GetAncestor(window: *mut c_void, flags: u32) -> *mut c_void;
        fn SetWinEventHook(
            event_min: u32,
            event_max: u32,
            module: *mut c_void,
            callback: unsafe extern "system" fn(*mut c_void, u32, *mut c_void, i32, i32, u32, u32),
            process: u32,
            thread: u32,
            flags: u32,
        ) -> *mut c_void;
        fn UnhookWinEvent(hook: *mut c_void) -> i32;
    }

    unsafe extern "system" fn foreground_changed(
        _hook: *mut c_void,
        _event: u32,
        _window: *mut c_void,
        _object: i32,
        _child: i32,
        _thread: u32,
        _time: u32,
    ) {
        FOREGROUND_CALLBACK.with(|slot| {
            if let Some(callback) = slot.borrow().as_ref() {
                callback();
            }
        });
    }

    pub struct ForegroundListener(*mut c_void);

    impl Drop for ForegroundListener {
        fn drop(&mut self) {
            // The guard stays on the same thread that installed the WinEvent hook.
            unsafe {
                UnhookWinEvent(self.0);
            }
            FOREGROUND_CALLBACK.with(|slot| *slot.borrow_mut() = None);
        }
    }

    pub fn watch_foreground(callback: impl Fn() + 'static) -> Result<ForegroundListener, String> {
        FOREGROUND_CALLBACK.with(|slot| *slot.borrow_mut() = Some(Box::new(callback)));
        // EVENT_SYSTEM_FOREGROUND only; WINEVENT_OUTOFCONTEXT needs no injected DLL.
        let hook =
            unsafe { SetWinEventHook(3, 3, std::ptr::null_mut(), foreground_changed, 0, 0, 0) };
        if hook.is_null() {
            let error = io::Error::last_os_error();
            FOREGROUND_CALLBACK.with(|slot| *slot.borrow_mut() = None);
            Err(format!("Watch foreground window: {error}"))
        } else {
            Ok(ForegroundListener(hook))
        }
    }

    pub fn window_has_focus(window: isize) -> bool {
        // Count owned dialogs as active, but not another application's foreground window.
        unsafe { GetAncestor(GetForegroundWindow(), 3) == window as *mut c_void }
    }

    const PROCESS_POWER_THROTTLING: i32 = 4;
    const EXECUTION_SPEED: u32 = 0x1;
    const IDLE_PRIORITY_CLASS: u32 = 0x40;

    #[repr(C)]
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct PowerThrottling {
        version: u32,
        control_mask: u32,
        state_mask: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn GetPriorityClass(process: *mut c_void) -> u32;
        fn SetPriorityClass(process: *mut c_void, priority: u32) -> i32;
        fn GetProcessInformation(
            process: *mut c_void,
            class: i32,
            information: *mut c_void,
            size: u32,
        ) -> i32;
        fn SetProcessInformation(
            process: *mut c_void,
            class: i32,
            information: *const c_void,
            size: u32,
        ) -> i32;
    }

    struct SavedPolicy {
        priority: u32,
        power: PowerThrottling,
    }

    static SAVED: Mutex<Option<SavedPolicy>> = Mutex::new(None);

    fn read_policy() -> io::Result<SavedPolicy> {
        let mut power = PowerThrottling {
            version: 1,
            control_mask: 0,
            state_mask: 0,
        };
        // The pseudo-handle needs no CloseHandle; the output buffer has the Win32 layout.
        unsafe {
            let process = GetCurrentProcess();
            let priority = GetPriorityClass(process);
            if priority == 0 {
                return Err(io::Error::last_os_error());
            }
            if GetProcessInformation(
                process,
                PROCESS_POWER_THROTTLING,
                (&mut power as *mut PowerThrottling).cast(),
                size_of::<PowerThrottling>() as u32,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(SavedPolicy { priority, power })
        }
    }

    fn set_priority(priority: u32) -> io::Result<()> {
        // Only change this process, never unrelated applications or WebView2 children.
        if unsafe { SetPriorityClass(GetCurrentProcess(), priority) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn set_power(power: PowerThrottling) -> io::Result<()> {
        // The synchronous call only borrows this correctly sized, initialized structure.
        if unsafe {
            SetProcessInformation(
                GetCurrentProcess(),
                PROCESS_POWER_THROTTLING,
                (&power as *const PowerThrottling).cast(),
                size_of::<PowerThrottling>() as u32,
            )
        } == 0
        {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    pub(super) fn set_background(background: bool) -> Result<bool, String> {
        let mut saved = SAVED.lock().map_err(|e| e.to_string())?;
        if background {
            if saved.is_some() {
                return Ok(false);
            }
            let previous = read_policy().map_err(|e| format!("Read CPU policy: {e}"))?;
            let eco = PowerThrottling {
                control_mask: previous.power.control_mask | EXECUTION_SPEED,
                state_mask: previous.power.state_mask | EXECUTION_SPEED,
                ..previous.power
            };
            set_power(eco).map_err(|e| format!("Enable EcoQoS: {e}"))?;
            // Save before the second API call so even a failed rollback remains retryable.
            *saved = Some(previous);
            if let Err(error) = set_priority(IDLE_PRIORITY_CLASS) {
                let previous = saved.as_ref().unwrap();
                if set_power(previous.power).is_ok() {
                    *saved = None;
                }
                return Err(format!("Lower CPU priority: {error}"));
            }
        } else if let Some(previous) = saved.as_ref() {
            // Restore responsiveness first. Retain the snapshot if either API fails.
            set_priority(previous.priority).map_err(|e| format!("Restore CPU priority: {e}"))?;
            let current = read_policy().map_err(|e| format!("Read CPU policy: {e}"))?;
            // Restore our execution-speed bits without changing unrelated power policies.
            set_power(PowerThrottling {
                control_mask: (current.power.control_mask & !EXECUTION_SPEED)
                    | (previous.power.control_mask & EXECUTION_SPEED),
                state_mask: (current.power.state_mask & !EXECUTION_SPEED)
                    | (previous.power.state_mask & EXECUTION_SPEED),
                ..current.power
            })
            .map_err(|e| format!("Restore CPU power policy: {e}"))?;
            *saved = None;
        } else {
            return Ok(false);
        }
        Ok(true)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn native_policy_round_trip() {
            // Isolate real process-wide scheduling changes from the other Rust tests.
            const CHILD: &str = "YAOC_EFFICIENCY_TEST_CHILD";
            if std::env::var_os(CHILD).is_none() {
                let result = std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "efficiency::windows::tests::native_policy_round_trip",
                    ])
                    .env(CHILD, "1")
                    .output()
                    .unwrap();
                assert!(
                    result.status.success(),
                    "{}\n{}",
                    String::from_utf8_lossy(&result.stdout),
                    String::from_utf8_lossy(&result.stderr)
                );
                return;
            }
            let before = read_policy().unwrap();
            assert!(!set_background(false).unwrap());
            for _ in 0..3 {
                assert!(set_background(true).unwrap());
                let background = read_policy().unwrap();
                assert_eq!(background.priority, IDLE_PRIORITY_CLASS);
                assert_eq!(
                    background.power.control_mask & EXECUTION_SPEED,
                    EXECUTION_SPEED
                );
                assert_eq!(
                    background.power.state_mask & EXECUTION_SPEED,
                    EXECUTION_SPEED
                );
                assert!(!set_background(true).unwrap());
                assert!(set_background(false).unwrap());
                let restored = read_policy().unwrap();
                assert_eq!(restored.priority, before.priority);
                assert_eq!(restored.power, before.power);
                assert!(!set_background(false).unwrap());
            }
        }
    }
}

/// Returns whether an actual transition was applied. Unsupported systems are non-fatal.
pub fn set_background(background: bool) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        windows::set_background(background)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = background;
        Ok(false)
    }
}

#[cfg(target_os = "windows")]
pub use windows::{watch_foreground, window_has_focus};
