import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import type { AgentInfo } from './types';

interface AgentSwitcherProps {
  agents: AgentInfo[];
  selectedAgentId: string;
  disabled?: boolean;
  variant?: 'agent' | 'gateway';
  onSelectAgent: (agentId: string) => void;
}

export default function AgentSwitcher({
  agents,
  selectedAgentId,
  disabled = false,
  variant = 'agent',
  onSelectAgent,
}: AgentSwitcherProps) {
  const label = variant === 'gateway' ? 'Active Gateway profile' : 'Active Agent';
  const popupId = variant + '-selector-popup';
  const [isOpen, setIsOpen] = useState(false);
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const currentAgent = agents.find((a) => a.id === selectedAgentId);
  const currentLabel = currentAgent
    ? variant === 'agent' && currentAgent.name && currentAgent.name !== currentAgent.id
      ? `${currentAgent.name} (${currentAgent.id})`
      : currentAgent.name || currentAgent.id
    : selectedAgentId || 'main';

  function closePopup(restoreFocus = false) {
    setIsOpen(false);
    if (restoreFocus) {
      buttonRef.current?.focus();
    }
  }

  useLayoutEffect(() => {
    if (!isOpen) return;
    const trigger = buttonRef.current;
    if (!trigger) return;

    const position = () => {
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 180), 360);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const spaceBelow = window.innerHeight - rect.bottom - 12;
      const spaceAbove = rect.top - 12;
      const openUpward = spaceBelow < 160 && spaceAbove > spaceBelow;

      if (openUpward) {
        setPopupStyle({
          position: 'fixed',
          zIndex: 140,
          width,
          left,
          bottom: window.innerHeight - rect.top + 4,
          maxHeight: Math.max(100, spaceAbove),
        });
      } else {
        setPopupStyle({
          position: 'fixed',
          zIndex: 140,
          width,
          left,
          top: rect.bottom + 4,
          maxHeight: Math.max(100, spaceBelow),
        });
      }
    };

    position();
    const observer = new ResizeObserver(position);
    observer.observe(trigger);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);

    const activeOption =
      popupRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ||
      popupRef.current?.querySelector<HTMLButtonElement>('[data-agent-option]:not(:disabled)');
    activeOption?.focus();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleOutside = (e: Event) => {
      const target = e.target as Node;
      if (!popupRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        closePopup();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closePopup(true);
      }
    };

    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('focusin', handleOutside);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('pointerdown', handleOutside);
      document.removeEventListener('focusin', handleOutside);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [isOpen]);

  const isDisabled = disabled || agents.length === 0;

  return (
    <div className={`agent-switcher-container ${variant}-switcher`}>
      <button
        type="button"
        ref={buttonRef}
        id={`active-${variant}-selector`}
        className="agent-selector"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? popupId : undefined}
        aria-label={label}
        title={`${label}: ${currentLabel}`}
        disabled={isDisabled}
        onClick={() => {
          if (!isDisabled) {
            setIsOpen((prev) => !prev);
          }
        }}
        onKeyDown={(e) => {
          if (isDisabled) return;
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsOpen(true);
          }
        }}
      >
        <span className="agent-selector-label">
          <span className="agent-selector-text">{currentLabel}</span>
        </span>
        <ChevronDown size={12} className={isOpen ? 'selector-chevron-open' : ''} />
      </button>

      {isOpen &&
        createPortal(
          <div
            ref={popupRef}
            id={popupId}
            className="session-selector-popup model-popup agent-popup"
            style={popupStyle}
            role="dialog"
            aria-label={variant === 'gateway' ? 'Select Gateway profile' : 'Select Agent'}
          >
            <div
              className="model-popup-list"
              role="listbox"
              aria-label={variant === 'gateway' ? 'Available Gateway profiles' : 'Available agents'}
              onKeyDown={(e) => {
                const options = Array.from(
                  popupRef.current?.querySelectorAll<HTMLButtonElement>(
                    '[data-agent-option]:not(:disabled)'
                  ) || []
                );
                const index = options.indexOf(document.activeElement as HTMLButtonElement);
                let next = index;
                if (e.key === 'ArrowDown') next = Math.min(index + 1, options.length - 1);
                else if (e.key === 'ArrowUp') next = Math.max(index - 1, 0);
                else if (e.key === 'Home') next = 0;
                else if (e.key === 'End') next = options.length - 1;
                else return;
                e.preventDefault();
                options[next]?.focus();
              }}
            >
              {agents.map((a) => {
                const isSelected = a.id === selectedAgentId;
                const hasCustomName = Boolean(a.name && a.name !== a.id);
                const showId = variant === 'agent';
                return (
                  <button
                    type="button"
                    key={a.id}
                    data-agent-option
                    role="option"
                    aria-selected={isSelected}
                    className="model-popup-option agent-popup-option"
                    title={showId && a.name ? `${a.name} (${a.id})` : a.name || a.id}
                    onClick={() => {
                      closePopup(true);
                      if (a.id !== selectedAgentId) {
                        onSelectAgent(a.id);
                      }
                    }}
                  >
                    <span className="agent-popup-item-content">
                      {hasCustomName ? (
                        <>
                          <span className="agent-popup-name">{a.name}</span>
                          {showId && <span className="agent-popup-id">({a.id})</span>}
                        </>
                      ) : (
                        <span className="agent-popup-name">{a.id}</span>
                      )}
                    </span>
                    {isSelected && <Check size={16} className="agent-popup-check" />}
                  </button>
                );
              })}
              {agents.length === 0 && (
                <p className="model-popup-empty">
                  {variant === 'gateway'
                    ? 'No Gateway profiles available.'
                    : 'No agents available.'}
                </p>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
