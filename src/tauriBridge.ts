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

export function initTauriBridge(): void {
  if (typeof window === 'undefined') return;
  if (window.openclawApi) return;

  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke) return;

  const invokeWithError = async <T = any>(cmd: string, args?: Record<string, any>): Promise<T> => {
    try {
      return await tauri.core.invoke<T>(cmd, args);
    } catch (err: any) {
      if (err instanceof Error) throw err;
      throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
    }
  };

  window.openclawApi = {
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

    onStatus: (callback: (status: ConnectionStatus) => void) => {
      let unlisten: (() => void) | null = null;
      let disposed = false;
      tauri.event
        .listen<ConnectionStatus>('gateway:status', (evt) => {
          if (!disposed) {
            callback(evt.payload);
          }
        })
        .then((fn) => {
          if (disposed) {
            fn();
          } else {
            unlisten = fn;
          }
        });
      return () => {
        disposed = true;
        if (unlisten) unlisten();
      };
    },

    onGatewayEvent: (callback: (frame: any) => void) => {
      let unlisten: (() => void) | null = null;
      let disposed = false;
      tauri.event
        .listen<any>('gateway:event', (evt) => {
          if (!disposed) {
            callback(evt.payload);
          }
        })
        .then((fn) => {
          if (disposed) {
            fn();
          } else {
            unlisten = fn;
          }
        });
      return () => {
        disposed = true;
        if (unlisten) unlisten();
      };
    },
  };
}
