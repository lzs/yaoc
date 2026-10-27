import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bell,
  Command,
  CornerDownLeft,
  FileCode,
  FileText,
  Folder,
  Layers,
  Keyboard,
  LogOut,
  MessageSquare,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import type { AgentInfo, SessionInfo, WorkspaceFileEntry } from './types';

export type QuickSwitcherMode = 'search' | 'command';

export interface QuickSwitcherCommand {
  id: string;
  title: string;
  category: string;
  shortcut?: string;
  icon: React.ReactNode;
  action: () => void;
}

interface QuickSwitcherProps {
  isOpen: boolean;
  initialMode: QuickSwitcherMode;
  onClose: () => void;
  sessions: SessionInfo[];
  selectedSessionKey: string;
  selectedAgentId: string;
  agents: AgentInfo[];
  workspaceFiles: WorkspaceFileEntry[];
  showWorkspacePane: boolean;
  theme: 'dark' | 'light' | 'system';
  notificationsEnabled: boolean;
  notificationSound: boolean;
  isConnected: boolean;
  onSelectSession: (key: string) => void;
  onSelectFile: (path: string) => void;
  onNewSession: () => void;
  onOpenSettings: () => void;
  onOpenKeyboardShortcuts: () => void;
  onToggleWorkspace: () => void;
  onToggleTheme: () => void;
  onClearSession: () => void;
  onSelectAgent: (agentId: string) => void;
  onToggleNotifications: () => void;
  onToggleSound: () => void;
  onTestNotification: () => void;
  onToggleConnect: () => void;
  onQuitApp: () => void;
}

interface SwitcherItem {
  id: string;
  type: 'session' | 'file' | 'command';
  title: string;
  subtitle?: string;
  badge?: string;
  shortcut?: string;
  icon: React.ReactNode;
  onSelect: () => void;
}

export default function QuickSwitcher({
  isOpen,
  initialMode,
  onClose,
  sessions,
  selectedSessionKey,
  selectedAgentId,
  agents,
  workspaceFiles,
  showWorkspacePane,
  theme,
  notificationsEnabled,
  notificationSound,
  isConnected,
  onSelectSession,
  onSelectFile,
  onNewSession,
  onOpenSettings,
  onOpenKeyboardShortcuts,
  onToggleWorkspace,
  onToggleTheme,
  onClearSession,
  onSelectAgent,
  onToggleNotifications,
  onToggleSound,
  onTestNotification,
  onToggleConnect,
  onQuitApp,
}: QuickSwitcherProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Initialize query based on initialMode
  useEffect(() => {
    if (isOpen) {
      if (initialMode === 'command') {
        setQuery('>');
      } else {
        setQuery('');
      }
      setSelectedIndex(0);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        if (initialMode === 'command') {
          inputRef.current?.setSelectionRange(1, 1);
        }
      });
    }
  }, [isOpen, initialMode]);

  const isCommandMode = query.startsWith('>');
  const cleanFilter = (isCommandMode ? query.slice(1) : query).trim().toLowerCase();

  // Build commands list
  const commands: SwitcherItem[] = useMemo(() => {
    const list: SwitcherItem[] = [
      {
        id: 'cmd-new-session',
        type: 'command',
        title: 'New Session',
        subtitle: 'Start a new conversation in current agent',
        icon: <Plus size={16} />,
        onSelect: () => {
          onClose();
          onNewSession();
        },
      },
      {
        id: 'cmd-settings',
        type: 'command',
        title: 'Open Settings',
        subtitle: 'Configure gateways, audio, notifications & shortcuts',
        shortcut: 'Ctrl+,',
        icon: <Settings size={16} />,
        onSelect: () => {
          onClose();
          onOpenSettings();
        },
      },
      {
        id: 'cmd-keyboard-shortcuts',
        type: 'command',
        title: 'Show Keyboard Shortcuts',
        subtitle: 'Learn shortcuts for search, commands, chat, and the workspace',
        shortcut: 'Ctrl+/',
        icon: <Keyboard size={16} />,
        onSelect: () => {
          onClose();
          onOpenKeyboardShortcuts();
        },
      },
      {
        id: 'cmd-workspace-toggle',
        type: 'command',
        title: showWorkspacePane ? 'Hide Workspace Drawer' : 'Show Workspace Drawer',
        subtitle: 'Toggle files and configuration editor',
        icon: <Folder size={16} />,
        onSelect: () => {
          onClose();
          onToggleWorkspace();
        },
      },
      {
        id: 'cmd-theme-toggle',
        type: 'command',
        title: `Switch Theme (Current: ${theme})`,
        subtitle: 'Cycle between dark, light, and system themes',
        icon: theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />,
        onSelect: () => {
          onClose();
          onToggleTheme();
        },
      },
      {
        id: 'cmd-clear-session',
        type: 'command',
        title: 'Reset / Clear Current Session',
        subtitle: 'Send /reset to Gateway to start session context over',
        icon: <Trash2 size={16} />,
        onSelect: () => {
          onClose();
          onClearSession();
        },
      },
      {
        id: 'cmd-toggle-notifications',
        type: 'command',
        title: notificationsEnabled ? 'Disable Desktop Notifications' : 'Enable Desktop Notifications',
        subtitle: 'Toggle Windows Action Center toast alerts',
        icon: <Bell size={16} />,
        onSelect: () => {
          onClose();
          onToggleNotifications();
        },
      },
      {
        id: 'cmd-toggle-sound',
        type: 'command',
        title: notificationSound ? 'Mute Completion Sounds' : 'Unmute Completion Sounds',
        subtitle: 'Toggle audio chime on assistant response completion',
        icon: <Volume2 size={16} />,
        onSelect: () => {
          onClose();
          onToggleSound();
        },
      },
      {
        id: 'cmd-test-notifications',
        type: 'command',
        title: 'Test Notification & Sound',
        subtitle: 'Trigger a preview toast banner and audio alert',
        icon: <Sparkles size={16} />,
        onSelect: () => {
          onClose();
          onTestNotification();
        },
      },
      {
        id: 'cmd-gateway-toggle',
        type: 'command',
        title: isConnected ? 'Disconnect Gateway' : 'Connect Gateway',
        subtitle: isConnected ? 'Close active WebSocket session' : 'Connect to active profile',
        icon: <RefreshCw size={16} />,
        onSelect: () => {
          onClose();
          onToggleConnect();
        },
      },
      {
        id: 'cmd-quit-app',
        type: 'command',
        title: 'Quit Application',
        subtitle: 'Close window and exit system tray',
        shortcut: 'Ctrl+Q',
        icon: <LogOut size={16} />,
        onSelect: () => {
          onClose();
          onQuitApp();
        },
      },
    ];

    // Add agent switchers if more than 1 agent available
    if (agents.length > 1) {
      agents.forEach((ag) => {
        if (ag.id !== selectedAgentId) {
          list.push({
            id: `cmd-switch-agent-${ag.id}`,
            type: 'command',
            title: `Switch Agent to ${ag.name || ag.id}`,
            subtitle: `Agent ID: ${ag.id}`,
            icon: <Layers size={16} />,
            onSelect: () => {
              onClose();
              onSelectAgent(ag.id);
            },
          });
        }
      });
    }

    return list;
  }, [
    showWorkspacePane,
    theme,
    notificationsEnabled,
    notificationSound,
    isConnected,
    agents,
    selectedAgentId,
    onClose,
    onNewSession,
    onOpenSettings,
    onOpenKeyboardShortcuts,
    onToggleWorkspace,
    onToggleTheme,
    onClearSession,
    onToggleNotifications,
    onToggleSound,
    onTestNotification,
    onToggleConnect,
    onQuitApp,
    onSelectAgent,
  ]);

  // Build sessions list
  const sessionItems: SwitcherItem[] = useMemo(() => {
    return sessions.map((s) => {
      const isCurrent = s.key === selectedSessionKey;
      const label = s.label || s.displayName || s.derivedTitle || s.key;
      return {
        id: `session-${s.key}`,
        type: 'session',
        title: label,
        subtitle: s.agentId ? `Agent: ${s.agentId} • ${s.key}` : s.key,
        badge: isCurrent ? 'current' : undefined,
        icon: <MessageSquare size={16} />,
        onSelect: () => {
          onClose();
          onSelectSession(s.key);
        },
      };
    });
  }, [sessions, selectedSessionKey, onClose, onSelectSession]);

  // Build workspace files list
  const fileItems: SwitcherItem[] = useMemo(() => {
    return workspaceFiles
      .filter((f) => f.kind !== 'directory')
      .map((f) => {
        const isMarkdown = f.name.endsWith('.md');
        return {
          id: `file-${f.path || f.name}`,
          type: 'file',
          title: f.name,
          subtitle: f.path !== f.name ? f.path : 'Workspace root',
          icon: isMarkdown ? <FileText size={16} /> : <FileCode size={16} />,
          onSelect: () => {
            onClose();
            onSelectFile(f.path || f.name);
          },
        };
      });
  }, [workspaceFiles, onClose, onSelectFile]);

  // Filter items based on mode and cleanFilter
  const filteredItems: SwitcherItem[] = useMemo(() => {
    if (isCommandMode) {
      if (!cleanFilter) return commands;
      return commands.filter(
        (cmd) =>
          cmd.title.toLowerCase().includes(cleanFilter) ||
          (cmd.subtitle && cmd.subtitle.toLowerCase().includes(cleanFilter))
      );
    }

    // In Search mode (Sessions + Files)
    const matches: SwitcherItem[] = [];
    const filterSessions = cleanFilter
      ? sessionItems.filter(
          (s) =>
            s.title.toLowerCase().includes(cleanFilter) ||
            (s.subtitle && s.subtitle.toLowerCase().includes(cleanFilter))
        )
      : sessionItems;

    const filterFiles = cleanFilter
      ? fileItems.filter(
          (f) =>
            f.title.toLowerCase().includes(cleanFilter) ||
            (f.subtitle && f.subtitle.toLowerCase().includes(cleanFilter))
        )
      : fileItems;

    // Prioritize sessions first, then files
    matches.push(...filterSessions);
    matches.push(...filterFiles);

    // If query also matches some commands, append them at the end
    if (cleanFilter) {
      const matchingCmds = commands.filter(
        (cmd) =>
          cmd.title.toLowerCase().includes(cleanFilter) ||
          (cmd.subtitle && cmd.subtitle.toLowerCase().includes(cleanFilter))
      );
      matches.push(...matchingCmds);
    }

    return matches;
  }, [isCommandMode, cleanFilter, commands, sessionItems, fileItems]);

  // Keep selected index in bounds
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredItems.length]);

  // Auto-scroll selected item into view
  useLayoutEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!isOpen) return null;

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (filteredItems.length > 0 ? (prev + 1) % filteredItems.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) =>
        filteredItems.length > 0 ? (prev - 1 + filteredItems.length) % filteredItems.length : 0
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const current = filteredItems[selectedIndex];
      if (current) {
        current.onSelect();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  return createPortal(
    <div
      className="quick-switcher-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="quick-switcher-card" role="dialog" aria-modal="true" aria-label="Quick Switcher">
        <div className="quick-switcher-search-bar">
          <div className="quick-switcher-icon">
            {isCommandMode ? <Command size={18} /> : <Search size={18} />}
          </div>
          <input
            ref={inputRef}
            className="quick-switcher-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isCommandMode
                ? 'Type a command or action...'
                : 'Search sessions and workspace files... (type > for commands)'
            }
            spellCheck={false}
          />
          {query && (
            <button
              type="button"
              className="quick-switcher-clear-btn"
              onClick={() => {
                setQuery(isCommandMode ? '>' : '');
                inputRef.current?.focus();
              }}
              title="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className="quick-switcher-list" ref={listRef} role="listbox">
          {filteredItems.length === 0 ? (
            <div className="quick-switcher-empty">
              No matching {isCommandMode ? 'commands' : 'sessions or files'} found
            </div>
          ) : (
            filteredItems.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={item.id}
                  className={`quick-switcher-item ${isSelected ? 'selected' : ''}`}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => item.onSelect()}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <div className={`quick-switcher-item-icon type-${item.type}`}>{item.icon}</div>
                  <div className="quick-switcher-item-content">
                    <div className="quick-switcher-item-title-row">
                      <span className="quick-switcher-item-title">{item.title}</span>
                      {item.badge && (
                        <span className={`quick-switcher-item-badge badge-${item.badge}`}>
                          {item.badge}
                        </span>
                      )}
                    </div>
                    {item.subtitle && (
                      <span className="quick-switcher-item-subtitle">{item.subtitle}</span>
                    )}
                  </div>
                  {item.shortcut && (
                    <div className="quick-switcher-item-shortcut">
                      <kbd>{item.shortcut}</kbd>
                    </div>
                  )}
                  {isSelected && (
                    <div className="quick-switcher-enter-hint" title="Execute">
                      <CornerDownLeft size={12} />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="quick-switcher-footer">
          <div className="quick-switcher-footer-hints">
            <span>
              <kbd>↑</kbd> <kbd>↓</kbd> navigate
            </span>
            <span>
              <kbd>↵</kbd> select
            </span>
            <span>
              <kbd>esc</kbd> close
            </span>
            {!isCommandMode ? (
              <span>
                type <kbd>&gt;</kbd> for commands
              </span>
            ) : (
              <span>
                backspace <kbd>&gt;</kbd> for sessions
              </span>
            )}
          </div>
          <div className="quick-switcher-footer-count">
            {filteredItems.length} result{filteredItems.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
