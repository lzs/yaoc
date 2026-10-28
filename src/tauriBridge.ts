import { ConnectionStatus, GatewayProfile, SystemInfo, UiSessionState } from './types';

declare global {
  interface Window {
    __TAURI__?: {
      core: {
        invoke: <T = any>(cmd: string, args?: Record<string, any>) => Promise<T>;
      };
      event: {
        listen: <T = any>(
          event: string,
          handler: (event: { payload: T }) => void
        ) => Promise<() => void>;
      };
    };
  }
}

export function playWebAudioChime(soundType?: string): void {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';

    if (soundType === 'warning' || soundType === 'error' || soundType === 'critical') {
      // 2-tone descending alert (880Hz -> 587Hz)
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(587, now + 0.12);
    } else {
      // 2-tone ascending chime (587Hz -> 880Hz)
      osc.frequency.setValueAtTime(587, now);
      osc.frequency.setValueAtTime(880, now + 0.12);
    }

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.38);
    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 500);
  } catch {
    // Ignored in headless/unsupported environments
  }
}

export function initTauriBridge(): void {
  if (typeof window === 'undefined') return;
  if (window.openclawApi) return;

  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke) return;

  const invoke = tauri.core.invoke;
  const listen = tauri.event?.listen;

  // Scrub raw Tauri internals from window to reduce IPC attack surface
  try {
    delete (window as any).__TAURI__;
    delete (window as any).__TAURI_INTERNALS__;
  } catch {}
  if ((window as any).__TAURI__) {
    try {
      (window as any).__TAURI__ = undefined;
    } catch {}
  }
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      (window as any).__TAURI_INTERNALS__ = undefined;
    } catch {}
  }

  const invokeWithError = async <T = any>(cmd: string, args?: Record<string, any>): Promise<T> => {
    try {
      return await invoke<T>(cmd, args);
    } catch (err: any) {
      if (err instanceof Error) throw err;
      throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
    }
  };

  const api = {
    getSystemInfo: () => invokeWithError<SystemInfo>('get_system_info'),

    loadProfiles: () =>
      invokeWithError<{
        profiles: GatewayProfile[];
        activeProfileId: string;
        uiState?: UiSessionState;
      }>('load_profiles'),

    saveProfiles: (profiles: GatewayProfile[], activeProfileId: string, uiState?: UiSessionState) =>
      invokeWithError<{ ok: boolean }>('save_profiles', {
        profiles,
        activeProfileId,
        uiState: uiState ?? null,
      }),

    connect: (profile: GatewayProfile) => invokeWithError<any>('gateway_connect', { profile }),

    disconnect: () => invokeWithError<{ ok: boolean }>('gateway_disconnect'),

    request: (method: string, params?: any, timeoutMs?: number) =>
      invokeWithError<any>('gateway_request', {
        method,
        params: params ?? {},
        timeoutMs: timeoutMs ?? 30000,
      }),

    setGlobalHotkey: (hotkey: string) =>
      invokeWithError<{ ok: boolean; hotkey: string }>('set_global_hotkey', { hotkey }),

    quitApp: () => invokeWithError<void>('quit_app'),

    windowAction: (action: 'minimize' | 'toggleMaximize' | 'close' | 'startDragging') =>
      invokeWithError<void>('window_action', { action }),
    getWindowMaximized: () => invokeWithError<boolean>('get_window_maximized'),
    onWindowMaximized: (callback: (maximized: boolean) => void) => {
      let unlisten: (() => void) | null = null;
      let disposed = false;
      if (listen) {
        listen<boolean>('window:maximized', (event) => {
          if (!disposed) callback(event.payload);
        })
          .then((cleanup) => {
            if (disposed) cleanup();
            else unlisten = cleanup;
          })
          .catch(() => {});
      }
      return () => {
        disposed = true;
        unlisten?.();
      };
    },

    openExternalUrl: (url: string) =>
      invokeWithError<{ ok: boolean }>('open_external_url', { url }),

    setTaskbarProgress: (status?: string, progress?: number) =>
      invokeWithError<void>('set_taskbar_progress', {
        status: status ?? 'none',
        progress: typeof progress === 'number' ? Math.round(progress) : null,
      }),

    showNotification: (title: string, body: string, sound?: boolean) => {
      if (sound) {
        playWebAudioChime('info');
      }
      return invokeWithError<void>('show_notification', { title, body, sound: sound ?? false });
    },

    playNotificationSound: (soundType?: string) => {
      playWebAudioChime(soundType);
      return invokeWithError<void>('play_notification_sound', { soundType: soundType ?? 'info' });
    },

    requestAttention: (level?: string) =>
      invokeWithError<void>('request_attention', { level: level ?? 'informational' }),

    onStatus: (callback: (status: ConnectionStatus) => void) => {
      let unlisten: (() => void) | null = null;
      let disposed = false;
      if (listen) {
        listen<ConnectionStatus>('gateway:status', (evt) => {
          if (!disposed) {
            callback(evt.payload);
          }
        }).then((fn) => {
          if (disposed) {
            fn();
          } else {
            unlisten = fn;
          }
        });
      }
      return () => {
        disposed = true;
        if (unlisten) unlisten();
      };
    },

    onGatewayEvent: (callback: (frame: any) => void) => {
      let unlisten: (() => void) | null = null;
      let disposed = false;
      if (listen) {
        listen<any>('gateway:event', (evt) => {
          if (!disposed) {
            callback(evt.payload);
          }
        }).then((fn) => {
          if (disposed) {
            fn();
          } else {
            unlisten = fn;
          }
        });
      }
      return () => {
        disposed = true;
        if (unlisten) unlisten();
      };
    },
  };

  Object.freeze(api);
  try {
    Object.defineProperty(window, 'openclawApi', {
      value: api,
      writable: false,
      configurable: false,
      enumerable: true,
    });
  } catch {
    window.openclawApi = api;
  }
}
