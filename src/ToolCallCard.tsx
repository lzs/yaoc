import React, { useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Copy,
  FileCode2,
  Globe,
  Loader2,
  Terminal,
  Wrench,
} from 'lucide-react';
import { ToolCallItem } from './types';

type ToolCategory = 'shell' | 'file' | 'web' | 'other';

function getToolCategory(name: string): ToolCategory {
  const n = name.toLowerCase();
  if (
    n.includes('bash') ||
    n.includes('exec') ||
    n.includes('sh') ||
    n.includes('cmd') ||
    n.includes('terminal') ||
    n.includes('command') ||
    n.includes('powershell')
  ) {
    return 'shell';
  }
  if (
    n.includes('file') ||
    n.includes('read') ||
    n.includes('write') ||
    n.includes('edit') ||
    n.includes('patch') ||
    n.includes('dir') ||
    n.includes('tree') ||
    n.includes('path')
  ) {
    return 'file';
  }
  if (
    n.includes('browser') ||
    n.includes('web') ||
    n.includes('search') ||
    n.includes('fetch') ||
    n.includes('url') ||
    n.includes('http') ||
    n.includes('curl')
  ) {
    return 'web';
  }
  return 'other';
}

function formatDuration(ms?: number): string | null {
  if (typeof ms !== 'number' || isNaN(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs < 10 ? secs.toFixed(2) : secs.toFixed(1)}s`;
  const mins = secs / 60;
  return `${mins.toFixed(1)}m`;
}

function extractPrimaryArg(args: any): string {
  if (!args) return '';
  if (typeof args === 'string') {
    const trimmed = args.trim();
    return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
  }
  if (typeof args === 'object') {
    const candidate =
      args.command ||
      args.cmd ||
      args.CommandLine ||
      args.script ||
      args.path ||
      args.filePath ||
      args.file ||
      args.Path ||
      args.query ||
      args.q ||
      args.url ||
      args.pattern ||
      args.name;
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
    }
    try {
      const json = JSON.stringify(args);
      return json.length > 50 ? `${json.slice(0, 47)}...` : json;
    } catch {
      return '';
    }
  }
  return '';
}

export function ToolCallCard({ toolCall }: { toolCall: ToolCallItem }) {
  const status = toolCall.status || 'completed';
  const isRunning = status === 'running';
  const isError = status === 'error' || Boolean(toolCall.error);

  const [isExpanded, setIsExpanded] = useState<boolean>(() => isRunning || isError);
  const [copiedArgs, setCopiedArgs] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);

  const category = getToolCategory(toolCall.name);
  const primaryArg = extractPrimaryArg(toolCall.args);
  const durationText = formatDuration(toolCall.durationMs);

  const handleCopyArgs = (e: React.MouseEvent) => {
    e.stopPropagation();
    const textToCopy =
      typeof toolCall.args === 'string' ? toolCall.args : JSON.stringify(toolCall.args, null, 2);
    navigator.clipboard.writeText(textToCopy);
    setCopiedArgs(true);
    setTimeout(() => setCopiedArgs(false), 1600);
  };

  const handleCopyOutput = (e: React.MouseEvent) => {
    e.stopPropagation();
    const textToCopy =
      typeof toolCall.result === 'string'
        ? toolCall.result
        : JSON.stringify(toolCall.result, null, 2);
    navigator.clipboard.writeText(textToCopy);
    setCopiedOutput(true);
    setTimeout(() => setCopiedOutput(false), 1600);
  };

  const renderIcon = () => {
    switch (category) {
      case 'shell':
        return <Terminal size={12} />;
      case 'file':
        return <FileCode2 size={12} />;
      case 'web':
        return <Globe size={12} />;
      default:
        return <Wrench size={12} />;
    }
  };

  // Determine command string for shell tools if available
  const commandStr =
    typeof toolCall.args === 'string'
      ? toolCall.args
      : toolCall.args?.command ||
        toolCall.args?.cmd ||
        toolCall.args?.CommandLine ||
        toolCall.args?.script;

  return (
    <div
      className={`tool-card ${isRunning ? 'running' : ''} ${isError ? 'error' : ''}`}
      data-testid="tool-call-card"
    >
      <button
        type="button"
        className="tool-card-header"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        title={isExpanded ? 'Click to collapse tool output' : 'Click to expand tool output'}
      >
        <div className="tool-card-left">
          <span className={`tool-category-badge ${category}`}>
            {renderIcon()}
            <span>{toolCall.name}</span>
          </span>
          {primaryArg && <span className="tool-card-teaser">{primaryArg}</span>}
        </div>

        <div className="tool-card-right">
          {durationText && <span className="tool-duration-pill">{durationText}</span>}

          {isRunning && (
            <span className="tool-status-pill running">
              <Loader2 size={11} className="tool-spinner" />
              <span>running</span>
            </span>
          )}

          {!isRunning && !isError && (
            <span className="tool-status-pill success">
              <Check size={11} />
              <span>
                {typeof toolCall.exitCode === 'number' && toolCall.exitCode !== 0
                  ? `exit ${toolCall.exitCode}`
                  : 'done'}
              </span>
            </span>
          )}

          {isError && (
            <span className="tool-status-pill error">
              <AlertCircle size={11} />
              <span>
                {typeof toolCall.exitCode === 'number' ? `exit ${toolCall.exitCode}` : 'failed'}
              </span>
            </span>
          )}

          <span className="tool-chevron">
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </div>
      </button>

      {isExpanded && (
        <div className="tool-card-body">
          {/* Arguments / Command Section */}
          {toolCall.args !== undefined && (
            <div className="tool-section">
              <div className="tool-section-label">
                <span>{commandStr ? 'Command' : 'Input Arguments'}</span>
                <button
                  type="button"
                  className="tool-mini-copy"
                  onClick={handleCopyArgs}
                  title="Copy arguments"
                >
                  {copiedArgs ? (
                    <>
                      <CheckCheck size={11} /> Copied
                    </>
                  ) : (
                    <>
                      <Copy size={11} /> Copy
                    </>
                  )}
                </button>
              </div>

              {commandStr ? (
                <div className="tool-command-box">
                  <span className="tool-prompt">$ </span>
                  <code className="tool-command-text">{commandStr}</code>
                </div>
              ) : (
                <pre className="tool-code-preview">
                  {typeof toolCall.args === 'string'
                    ? toolCall.args
                    : JSON.stringify(toolCall.args, null, 2)}
                </pre>
              )}
            </div>
          )}

          {/* Error Section if any */}
          {toolCall.error && (
            <div className="tool-section">
              <div className="tool-section-label">
                <span>Error Diagnostic</span>
              </div>
              <div className="tool-error-callout">
                <AlertCircle size={13} style={{ flexShrink: 0, marginTop: '2px' }} />
                <span>{toolCall.error}</span>
              </div>
            </div>
          )}

          {/* Result / Output Section */}
          {toolCall.result !== undefined && (
            <div className="tool-section">
              <div className="tool-section-label">
                <span>Execution Output</span>
                <button
                  type="button"
                  className="tool-mini-copy"
                  onClick={handleCopyOutput}
                  title="Copy output"
                >
                  {copiedOutput ? (
                    <>
                      <CheckCheck size={11} /> Copied
                    </>
                  ) : (
                    <>
                      <Copy size={11} /> Copy Output
                    </>
                  )}
                </button>
              </div>
              <pre className="tool-output-content">
                {typeof toolCall.result === 'string'
                  ? toolCall.result || '(empty output)'
                  : JSON.stringify(toolCall.result, null, 2)}
              </pre>
            </div>
          )}

          {/* Running State with No Result Yet */}
          {isRunning && toolCall.result === undefined && (
            <div className="tool-running-shimmer">
              <Loader2 size={12} className="tool-spinner" />
              <span>Executing tool...</span>
            </div>
          )}

          {/* Completed with No Result and No Error */}
          {!isRunning && toolCall.result === undefined && !toolCall.error && (
            <div className="tool-empty-output">(No output returned)</div>
          )}
        </div>
      )}
    </div>
  );
}
