import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, RefreshCw, Search } from 'lucide-react';
import {
  changeSessionModel,
  loadSessionModels,
  loadSessionThinking,
  normalizeThinkingMetadata,
  reasoningOptions,
  thinkingLevelLabel,
  modelRef,
  ModelOption,
  toGatewaySessionKey,
} from './models';
import type { ThinkingMetadata } from './types';

interface Props {
  leadingControl?: React.ReactNode;
  connectionId: string;
  connected: boolean;
  agentId: string;
  sessionKey: string;
  model?: string;
  modelProvider?: string;
  thinkingLevel?: string;
  thinkingMetadata?: ThinkingMetadata;
  streaming: boolean;
  onBusyChange: (busy: boolean) => void;
  onThinkingChanged: (thinkingLevel: string) => void;
  onModelChanged: (
    selection: ThinkingMetadata & { model: string; modelProvider: string; thinkingLevel?: string }
  ) => void;
}

export default function SessionModelSwitcher(props: Props) {
  const {
    connected,
    agentId,
    sessionKey,
    model,
    modelProvider,
    streaming,
    onBusyChange,
    onModelChanged,
  } = props;
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [popup, setPopup] = useState<'model' | 'thinking' | null>(null);
  const [search, setSearch] = useState('');
  const [draftThinking, setDraftThinking] = useState(props.thinkingLevel || '');
  const [lastSliderLevel, setLastSliderLevel] = useState('');
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({});
  const modelButton = useRef<HTMLButtonElement>(null);
  const thinkingButton = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const scope = JSON.stringify([props.connectionId, connected, agentId, sessionKey]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const changeInFlight = useRef(false);
  const current = modelRef(model, modelProvider);
  const modelLabel =
    models.find((choice) => choice.ref === current)?.label || current || 'Agent default';
  const metadata = {
    ...normalizeThinkingMetadata(models.find((choice) => choice.ref === current)),
    ...normalizeThinkingMetadata(props.thinkingMetadata),
  };
  const thinkingOptions = reasoningOptions(metadata, props.thinkingLevel || '');
  const sliderOptions = thinkingOptions.filter(
    (option) => !['off', 'none', 'adaptive'].includes(option.id)
  );
  const noneOption = thinkingOptions.find((option) => option.id === 'off' || option.id === 'none');
  const adaptiveOption = thinkingOptions.find((option) => option.id === 'adaptive');
  const sliderActive = sliderOptions.some((option) => option.id === draftThinking);
  const sliderIndex = Math.max(
    0,
    sliderOptions.findIndex(
      (option) => option.id === (sliderActive ? draftThinking : lastSliderLevel)
    )
  );
  const thinkingLabel = (level: string) => {
    if (level === 'off' || level === 'none') return 'None';
    return (
      thinkingOptions.find((option) => option.id === level)?.label || thinkingLevelLabel(level)
    );
  };
  const defaultLabel = metadata.thinkingDefault
    ? 'Default (' + thinkingLabel(metadata.thinkingDefault) + ')'
    : 'Default';
  const choices = [
    { ref: '', label: 'Agent default', available: true },
    ...(current && !models.some((choice) => choice.ref === current)
      ? [{ ref: current, label: `${current} (current)`, available: true }]
      : []),
    ...models,
  ].filter((choice) =>
    `${choice.label} ${choice.ref}`.toLowerCase().includes(search.toLowerCase())
  );

  function closePopup(restoreFocus = false) {
    setPopup(null);
    if (restoreFocus) (popup === 'model' ? modelButton : thinkingButton).current?.focus();
  }

  useEffect(() => {
    setPopup(null);
    setSearch('');
  }, [scope, streaming, current]);
  useEffect(() => {
    setDraftThinking(props.thinkingLevel || '');
  }, [props.thinkingLevel, scope]);

  useLayoutEffect(() => {
    if (!popup) return;
    const trigger = (popup === 'model' ? modelButton : thinkingButton).current;
    if (!trigger) return;
    const position = () => {
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(popup === 'model' ? 420 : 340, window.innerWidth - 24);
      setPopupStyle({
        width,
        left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        bottom: window.innerHeight - rect.top + 8,
        maxHeight: Math.max(0, rect.top - 20),
      });
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(trigger);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    const focusTarget =
      (popup === 'model' ? searchRef : sliderRef).current ||
      popupRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    focusTarget?.focus();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [popup, error]);

  useEffect(() => {
    if (!popup) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (
        !popupRef.current?.contains(target) &&
        !modelButton.current?.contains(target) &&
        !thinkingButton.current?.contains(target)
      )
        closePopup();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePopup(true);
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [popup]);

  useEffect(() => {
    let cancelled = false;
    setModels([]);
    setError('');
    const api = window.openclawApi;
    if (!connected || !api) {
      setLoading(false);
      return;
    }
    setLoading(true);
    loadSessionModels(api.request, agentId, sessionKey)
      .then((choices) => {
        if (!cancelled) setModels(choices);
      })
      .catch((err) => {
        if (!cancelled) setError(`Could not load models: ${err?.message || String(err)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, reload, current]);

  async function handleChange(selection: string) {
    const api = window.openclawApi;
    if (!api || !connected || streaming || changeInFlight.current || selection === current) return;
    const requestScope = scope;
    changeInFlight.current = true;
    setChanging(true);
    setError('');
    onBusyChange(true);
    try {
      const result = await changeSessionModel(api.request, sessionKey, selection, agentId);
      if (latestScope.current !== requestScope) return;
      // Older Gateways may not include capabilities in the patch response.
      let fresh: ThinkingMetadata & { thinkingLevel?: string } = {};
      try {
        fresh = await loadSessionThinking(api.request, agentId, sessionKey);
      } catch {
        /* Use model catalog metadata or the legacy compatibility choices. */
      }
      if (latestScope.current === requestScope) onModelChanged({ ...result, ...fresh });
    } catch (err: any) {
      if (latestScope.current === requestScope)
        setError(`Could not change model: ${err?.message || String(err)}`);
    } finally {
      changeInFlight.current = false;
      setChanging(false);
      onBusyChange(false);
    }
  }

  async function handleThinkingChange(selection: string) {
    const api = window.openclawApi;
    if (!api || !connected || streaming || changeInFlight.current) return;
    if (selection && !thinkingOptions.some((option) => option.id === selection)) return;
    setDraftThinking(selection);
    if (sliderOptions.some((option) => option.id === selection)) setLastSliderLevel(selection);
    if (selection === (props.thinkingLevel || '')) return;
    const requestScope = scope;
    changeInFlight.current = true;
    setChanging(true);
    setError('');
    onBusyChange(true);
    try {
      const key = toGatewaySessionKey(agentId, sessionKey);
      const result = await api.request('sessions.patch', { key, thinkingLevel: selection || null });
      if (result?.ok === false)
        throw new Error(result.error?.message || 'The Gateway rejected the reasoning change.');
      if (latestScope.current === requestScope) {
        // Clearing the override remains Default even if the Gateway returns an effective level.
        const saved =
          selection === ''
            ? ''
            : typeof result?.entry?.thinkingLevel === 'string'
              ? result.entry.thinkingLevel
              : selection;
        setDraftThinking(saved);
        props.onThinkingChanged(saved);
      }
    } catch (err: any) {
      if (latestScope.current === requestScope) {
        setDraftThinking(props.thinkingLevel || '');
        setError(`Could not change reasoning: ${err?.message || String(err)}`);
      }
    } finally {
      changeInFlight.current = false;
      setChanging(false);
      onBusyChange(false);
    }
  }

  return (
    <div className="session-model-control">
      <div className="session-model-row">
        <div className="session-model-leading">
          {props.leadingControl}
          <button
            type="button"
            className="composer-icon-btn session-model-refresh"
            aria-label="Refresh available models"
            title="Refresh available models"
            disabled={!connected || loading || changing}
            onClick={() => setReload((value) => value + 1)}
          >
            <RefreshCw size={13} className={loading || changing ? 'spin-icon' : ''} />
          </button>
        </div>
        <button
          type="button"
          ref={modelButton}
          id="session-model"
          aria-label="Session model"
          className="session-selector session-model-select"
          aria-haspopup="dialog"
          aria-expanded={popup === 'model'}
          aria-controls={popup === 'model' ? 'session-selector-popup' : undefined}
          disabled={!connected || loading || changing || streaming}
          aria-describedby="session-model-status"
          onClick={() => {
            setSearch('');
            setPopup(popup === 'model' ? null : 'model');
          }}
          title={
            streaming
              ? 'Wait for the current response to finish before changing models'
              : current || 'Use the agent’s default model'
          }
        >
          <span>{modelLabel}</span>
          <ChevronDown size={12} className={popup === 'model' ? 'selector-chevron-open' : ''} />
        </button>
        <button
          type="button"
          ref={thinkingButton}
          className="session-selector session-thinking-select"
          aria-label="Reasoning effort"
          aria-haspopup="dialog"
          aria-expanded={popup === 'thinking'}
          aria-controls={popup === 'thinking' ? 'session-selector-popup' : undefined}
          title="Reasoning effort for this session"
          disabled={!connected || changing || streaming}
          onClick={() => {
            setDraftThinking(props.thinkingLevel || '');
            setPopup(popup === 'thinking' ? null : 'thinking');
          }}
        >
          <span>{props.thinkingLevel ? thinkingLabel(props.thinkingLevel) : defaultLabel}</span>
          <ChevronDown size={12} className={popup === 'thinking' ? 'selector-chevron-open' : ''} />
        </button>
        <span id="session-model-status" className="session-model-status" role="status">
          {changing
            ? 'Changing model…'
            : loading
              ? 'Loading models…'
              : !connected
                ? 'Connect to select a model'
                : streaming
                  ? 'Available after this response'
                  : models.length === 0 && !error
                    ? 'No models listed'
                    : 'This session only'}
        </span>
      </div>
      {error && (
        <div className="session-model-error" role="alert">
          {error}
        </div>
      )}
      {popup &&
        createPortal(
          <div
            ref={popupRef}
            id="session-selector-popup"
            className={`session-selector-popup ${popup === 'model' ? 'model-popup' : 'thinking-popup'}`}
            style={popupStyle}
            role="dialog"
            aria-label={popup === 'model' ? 'Choose model' : 'Reasoning effort settings'}
          >
            {popup === 'model' ? (
              <>
                <div className="model-search">
                  <Search size={17} />
                  <input
                    ref={searchRef}
                    aria-label="Search models"
                    placeholder="Search models"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        popupRef.current
                          ?.querySelector<HTMLButtonElement>('[data-model-option]:not(:disabled)')
                          ?.focus();
                      }
                    }}
                  />
                </div>
                <div
                  className="model-popup-list"
                  role="listbox"
                  aria-label="Available models"
                  onKeyDown={(event) => {
                    const options = Array.from(
                      popupRef.current?.querySelectorAll<HTMLButtonElement>(
                        '[data-model-option]:not(:disabled)'
                      ) || []
                    );
                    const index = options.indexOf(document.activeElement as HTMLButtonElement);
                    let next = index;
                    if (event.key === 'ArrowDown') next = Math.min(index + 1, options.length - 1);
                    else if (event.key === 'ArrowUp') next = Math.max(index - 1, 0);
                    else if (event.key === 'Home') next = 0;
                    else if (event.key === 'End') next = options.length - 1;
                    else return;
                    event.preventDefault();
                    options[next]?.focus();
                  }}
                >
                  {choices.map((choice) => (
                    <button
                      type="button"
                      key={choice.ref}
                      data-model-option
                      role="option"
                      aria-selected={choice.ref === current}
                      disabled={!choice.available || changing}
                      className="model-popup-option"
                      title={choice.ref || choice.label}
                      onClick={() => {
                        closePopup(true);
                        void handleChange(choice.ref);
                      }}
                    >
                      <span>
                        {choice.label}
                        {!choice.available ? ' (unavailable)' : ''}
                      </span>
                      {choice.ref === current && <Check size={17} />}
                    </button>
                  ))}
                  {choices.length === 0 && (
                    <p className="model-popup-empty">No models match your search.</p>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="thinking-popup-heading">
                  <span>Effort</span>
                  <strong aria-live="polite">
                    {draftThinking ? thinkingLabel(draftThinking) : defaultLabel}
                  </strong>
                </div>
                <div className="thinking-modes" role="group" aria-label="Reasoning mode">
                  <button
                    type="button"
                    aria-pressed={draftThinking === ''}
                    disabled={changing}
                    title="Use the Gateway's configured default"
                    onClick={() => void handleThinkingChange('')}
                  >
                    Default
                  </button>
                  <button
                    type="button"
                    aria-pressed={draftThinking === 'off' || draftThinking === 'none'}
                    disabled={changing || !noneOption}
                    title={noneOption ? 'Turn reasoning off' : 'Not advertised for this model'}
                    onClick={() => noneOption && void handleThinkingChange(noneOption.id)}
                  >
                    None
                  </button>
                  <button
                    type="button"
                    aria-pressed={draftThinking === 'adaptive'}
                    disabled={changing || !adaptiveOption}
                    title={
                      adaptiveOption
                        ? 'Let the provider manage reasoning effort'
                        : 'Not advertised for this model'
                    }
                    onClick={() => adaptiveOption && void handleThinkingChange(adaptiveOption.id)}
                  >
                    Adaptive
                  </button>
                </div>
                {sliderOptions.length > 1 ? (
                  <>
                    <div
                      className={
                        'thinking-slider-track ' + (sliderActive ? 'is-active' : 'is-muted')
                      }
                    >
                      <div className="thinking-slider-ticks" aria-hidden="true">
                        {sliderOptions.map((option) => (
                          <i key={option.id} title={option.label} />
                        ))}
                      </div>
                      <input
                        ref={sliderRef}
                        type="range"
                        min={0}
                        max={sliderOptions.length - 1}
                        step={1}
                        value={sliderIndex}
                        aria-label="Reasoning effort"
                        aria-valuetext={sliderOptions[sliderIndex]?.label}
                        aria-describedby="thinking-slider-status"
                        disabled={changing}
                        onChange={(event) => {
                          const level = sliderOptions[Number(event.target.value)].id;
                          setLastSliderLevel(level);
                          setDraftThinking(level);
                        }}
                        onPointerUp={(event) => {
                          const level = sliderOptions[Number(event.currentTarget.value)]?.id;
                          if (level) void handleThinkingChange(level);
                        }}
                        onKeyUp={(event) => {
                          if (
                            [
                              'ArrowLeft',
                              'ArrowRight',
                              'ArrowUp',
                              'ArrowDown',
                              'Home',
                              'End',
                              'PageUp',
                              'PageDown',
                            ].includes(event.key)
                          ) {
                            const level = sliderOptions[Number(event.currentTarget.value)]?.id;
                            if (level) void handleThinkingChange(level);
                          }
                        }}
                        onPointerCancel={() => setDraftThinking(props.thinkingLevel || '')}
                      />
                    </div>
                    <div className="thinking-slider-labels" aria-hidden="true">
                      <span>{sliderOptions[0].label}</span>
                      <span>{sliderOptions[sliderOptions.length - 1].label}</span>
                    </div>
                  </>
                ) : sliderOptions.length === 1 ? (
                  <div className="thinking-modes">
                    <button
                      type="button"
                      aria-pressed={sliderActive}
                      disabled={changing}
                      onClick={() => void handleThinkingChange(sliderOptions[0].id)}
                    >
                      {sliderOptions[0].label}
                    </button>
                  </div>
                ) : (
                  <p className="thinking-options-note">
                    No adjustable effort levels for this model.
                  </p>
                )}
                <p className="thinking-options-note" id="thinking-slider-status">
                  {sliderOptions.length === 0
                    ? 'Only the advertised modes are available.'
                    : sliderActive
                      ? 'Fixed effort selected.'
                      : 'Choose an effort level to override this mode.'}
                </p>
                {props.thinkingLevel &&
                  !thinkingOptions.some((option) => option.id === props.thinkingLevel) && (
                    <p className="thinking-options-note">
                      The saved setting is not advertised for this model.
                    </p>
                  )}
              </>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
