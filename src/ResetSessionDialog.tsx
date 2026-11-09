import { useLayoutEffect, useRef, type RefObject } from 'react';
import { RotateCcw, X } from 'lucide-react';

interface Props {
  name: string;
  sessionKey: string;
  fallbackFocusRef: RefObject<HTMLTextAreaElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ResetSessionDialog({
  name,
  sessionKey,
  fallbackFocusRef,
  onConfirm,
  onCancel,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus({ preventScroll: true });
    const keepFocusInside = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialogRef.current?.contains(event.target))
        cancelRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', keepFocusInside);
    return () => {
      document.removeEventListener('focusin', keepFocusInside);
      requestAnimationFrame(() => {
        if (document.querySelector('[role="dialog"]')) return;
        if (
          previousFocus?.isConnected &&
          previousFocus !== document.body &&
          !previousFocus.matches(':disabled')
        )
          previousFocus.focus({ preventScroll: true });
        else fallbackFocusRef.current?.focus({ preventScroll: true });
      });
    };
  }, [fallbackFocusRef]);

  return (
    <div
      className="modal-backdrop reset-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="modal-card reset-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reset-dialog-title"
        aria-describedby="reset-dialog-description"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
            return;
          }
          if (
            (event.ctrlKey || event.metaKey) &&
            ['p', 'f', 'q', ',', '/', 'PageUp', 'PageDown'].includes(
              event.key.length === 1 ? event.key.toLowerCase() : event.key
            )
          ) {
            event.preventDefault();
            return;
          }
          if (event.key !== 'Tab') return;
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
          );
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className="reset-dialog-header">
          <div className="reset-dialog-symbol">
            <RotateCcw size={21} aria-hidden="true" />
          </div>
          <div className="reset-dialog-heading">
            <h3 id="reset-dialog-title">Reset this session?</h3>
            <p id="reset-dialog-description">Start fresh with a new conversation context.</p>
          </div>
          <button
            type="button"
            className="btn reset-dialog-close"
            aria-label="Cancel reset"
            title="Close"
            onClick={onCancel}
          >
            <X size={16} />
          </button>
        </div>
        <div className="reset-dialog-session">
          <span className="reset-dialog-label">Session</span>
          <strong>{name}</strong>
          <code>{sessionKey}</code>
        </div>
        <div className="reset-dialog-footer">
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            <RotateCcw size={14} aria-hidden="true" /> Reset session
          </button>
        </div>
      </div>
    </div>
  );
}
