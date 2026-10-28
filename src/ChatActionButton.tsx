import { useState, type ReactNode } from 'react';

interface Props {
  id: string;
  label: string;
  busyLabel: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}

export default function ChatActionButton({
  id,
  label,
  busyLabel,
  busy,
  disabled,
  onClick,
  children,
}: Props) {
  const [dismissed, setDismissed] = useState(false);
  return (
    <span
      className="chat-action"
      data-tooltip-dismissed={dismissed || undefined}
      onMouseEnter={() => setDismissed(false)}
      onMouseLeave={() => setDismissed(false)}
    >
      <button
        type="button"
        className={`btn chat-action-button${busy ? ' is-busy' : ''}`}
        aria-label={label}
        aria-describedby={`${id}-tooltip`}
        aria-busy={busy}
        aria-disabled={disabled || busy}
        disabled={disabled}
        onClick={busy ? undefined : onClick}
        onFocus={() => setDismissed(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            setDismissed(true);
          }
        }}
      >
        {children}
      </button>
      <span id={`${id}-tooltip`} role="tooltip" className="chat-action-tooltip">
        {busy ? busyLabel : label}
      </span>
      <span className="chat-action-status" role="status">
        {busy ? busyLabel : ''}
      </span>
    </span>
  );
}
