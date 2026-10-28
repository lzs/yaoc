import { useEffect, useState, type ReactNode } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';

function windowAction(action: 'minimize' | 'toggleMaximize' | 'close' | 'startDragging') {
  void window.openclawApi?.windowAction?.(action).catch(console.error);
}

export default function TitleBar({
  platform,
  children,
}: {
  platform?: string;
  children: ReactNode;
}) {
  const [maximized, setMaximized] = useState(false);
  const macOS = platform === 'darwin';
  useEffect(() => {
    const api = window.openclawApi;
    let disposed = false;
    let receivedEvent = false;
    const unsubscribe = api?.onWindowMaximized?.((value) => {
      receivedEvent = true;
      setMaximized(value);
    });
    void api
      ?.getWindowMaximized?.()
      .then((value) => {
        if (!disposed && !receivedEvent) setMaximized(value);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  return (
    <header
      className={`topbar integrated-titlebar${macOS ? ' macos-titlebar' : ''}`}
      onMouseDown={(event) => {
        if (
          event.button !== 0 ||
          (event.target as HTMLElement).closest('button, select, input, a, [role="button"]')
        )
          return;
        event.preventDefault();
        windowAction(event.detail === 2 ? 'toggleMaximize' : 'startDragging');
      }}
    >
      {children}
      {!macOS && (
        <div className="window-controls" role="group" aria-label="Window controls">
          <button
            type="button"
            className="window-control"
            aria-label="Minimize window"
            title="Minimize"
            onClick={() => windowAction('minimize')}
          >
            <Minus size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="window-control"
            aria-label={maximized ? 'Restore window' : 'Maximize window'}
            title={maximized ? 'Restore' : 'Maximize'}
            onClick={() => windowAction('toggleMaximize')}
          >
            {maximized ? (
              <Copy size={12} aria-hidden="true" />
            ) : (
              <Square size={12} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="window-control window-close"
            aria-label="Close window"
            title="Close"
            onClick={() => windowAction('close')}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </header>
  );
}
