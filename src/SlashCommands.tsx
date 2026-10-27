import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Bug,
  CheckCircle,
  Code2,
  FileText,
  HelpCircle,
  Minimize2,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Terminal,
} from 'lucide-react';
import type { PromptTemplate } from './types';

export interface SlashItem {
  id: string;
  trigger: string; // without leading slash, e.g. "reset"
  label: string;
  category: 'command' | 'template';
  description: string;
  templateText?: string;
  icon: React.ReactNode;
}

export const DEFAULT_PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'builtin-review',
    trigger: 'review',
    label: 'Code Review',
    template: 'Review the following code for bugs, edge cases, and security vulnerabilities:\n\n',
    isBuiltIn: true,
  },
  {
    id: 'builtin-test',
    trigger: 'test',
    label: 'Unit Tests',
    template: 'Write comprehensive unit tests with edge cases for the following code:\n\n',
    isBuiltIn: true,
  },
  {
    id: 'builtin-fix',
    trigger: 'fix',
    label: 'Debug & Fix',
    template: 'Debug and resolve the following issue. Explain the root cause and provide the solution:\n\n',
    isBuiltIn: true,
  },
  {
    id: 'builtin-explain',
    trigger: 'explain',
    label: 'Explain Code',
    template: 'Explain how the following code works step-by-step and its architectural concepts:\n\n',
    isBuiltIn: true,
  },
  {
    id: 'builtin-refactor',
    trigger: 'refactor',
    label: 'Refactor Code',
    template: 'Refactor the following code for better readability, maintainability, and idiomatic style:\n\n',
    isBuiltIn: true,
  },
  {
    id: 'builtin-doc',
    trigger: 'doc',
    label: 'Documentation',
    template: 'Generate clear, complete documentation and docstrings for the following:\n\n',
    isBuiltIn: true,
  },
];

const BUILTIN_GATEWAY_COMMANDS: SlashItem[] = [
  {
    id: 'cmd-reset',
    trigger: 'reset',
    label: '/reset',
    category: 'command',
    description: 'Reset conversation context and start fresh',
    icon: <RotateCcw size={15} />,
  },
  {
    id: 'cmd-compact',
    trigger: 'compact',
    label: '/compact',
    category: 'command',
    description: 'Request Gateway to summarize previous context to save tokens',
    icon: <Minimize2 size={15} />,
  },
  {
    id: 'cmd-status',
    trigger: 'status',
    label: '/status',
    category: 'command',
    description: 'Check Gateway and agent session health & token stats',
    icon: <Terminal size={15} />,
  },
  {
    id: 'cmd-stop',
    trigger: 'stop',
    label: '/stop',
    category: 'command',
    description: 'Abort currently running generation or tool execution',
    icon: <Square size={15} />,
  },
  {
    id: 'cmd-help',
    trigger: 'help',
    label: '/help',
    category: 'command',
    description: 'Display Gateway help and available commands',
    icon: <HelpCircle size={15} />,
  },
];

interface SlashCommandsProps {
  isOpen: boolean;
  filter: string; // text typed after slash, e.g. "rev"
  customTemplates?: PromptTemplate[];
  onSelect: (item: SlashItem) => void;
  onClose: () => void;
}

export default function SlashCommands({
  isOpen,
  filter,
  customTemplates = [],
  onSelect,
  onClose,
}: SlashCommandsProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Combine built-in commands, built-in templates, and custom templates
  const allItems: SlashItem[] = useMemo(() => {
    const list: SlashItem[] = [...BUILTIN_GATEWAY_COMMANDS];

    // Built-in templates
    DEFAULT_PROMPT_TEMPLATES.forEach((tpl) => {
      let icon = <FileText size={15} />;
      if (tpl.trigger === 'review') icon = <CheckCircle size={15} />;
      if (tpl.trigger === 'test') icon = <Play size={15} />;
      if (tpl.trigger === 'fix') icon = <Bug size={15} />;
      if (tpl.trigger === 'explain') icon = <BookOpen size={15} />;
      if (tpl.trigger === 'refactor') icon = <Code2 size={15} />;

      list.push({
        id: tpl.id,
        trigger: tpl.trigger,
        label: `/${tpl.trigger}`,
        category: 'template',
        description: tpl.label,
        templateText: tpl.template,
        icon,
      });
    });

    // Custom user templates
    customTemplates.forEach((tpl) => {
      const cleanTrigger = tpl.trigger.replace(/^\/+/, '');
      list.push({
        id: tpl.id,
        trigger: cleanTrigger,
        label: `/${cleanTrigger}`,
        category: 'template',
        description: tpl.label || 'Custom Template',
        templateText: tpl.template,
        icon: <Sparkles size={15} />,
      });
    });

    return list;
  }, [customTemplates]);

  // Filter items matching filter string
  const cleanFilter = filter.toLowerCase().trim();
  const filteredItems = useMemo(() => {
    if (!cleanFilter) return allItems;
    return allItems.filter(
      (item) =>
        item.trigger.toLowerCase().includes(cleanFilter) ||
        item.label.toLowerCase().includes(cleanFilter) ||
        item.description.toLowerCase().split(/\s+/).some((w) => w.startsWith(cleanFilter))
    );
  }, [allItems, cleanFilter]);

  // Reset selected index when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredItems.length, cleanFilter]);

  // Keep selected item visible
  useLayoutEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  // Key navigation handler to be used by caller or key listener
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((prev) =>
          filteredItems.length > 0 ? (prev + 1) % filteredItems.length : 0
        );
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((prev) =>
          filteredItems.length > 0 ? (prev - 1 + filteredItems.length) % filteredItems.length : 0
        );
      } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        if (filteredItems.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          const item = filteredItems[selectedIndex];
          if (item) onSelect(item);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, filteredItems, selectedIndex, onSelect, onClose]);

  if (!isOpen || filteredItems.length === 0) return null;

  return (
    <div className="slash-menu-portal" role="listbox" aria-label="Slash command suggestions">
      <div className="slash-menu-header">
        <span className="slash-menu-title">Commands & Prompt Templates</span>
        <span className="slash-menu-hint">Tab or Enter to insert</span>
      </div>
      <div className="slash-menu-list" ref={listRef}>
        {filteredItems.map((item, idx) => {
          const isSelected = idx === selectedIndex;
          return (
            <div
              key={item.id}
              className={`slash-menu-item ${isSelected ? 'selected' : ''}`}
              role="option"
              aria-selected={isSelected}
              onClick={() => onSelect(item)}
              onMouseEnter={() => setSelectedIndex(idx)}
            >
              <div className={`slash-menu-icon category-${item.category}`}>{item.icon}</div>
              <div className="slash-menu-info">
                <div className="slash-menu-label-row">
                  <span className="slash-menu-trigger">{item.label}</span>
                  <span className="slash-menu-description">{item.description}</span>
                  <span className={`slash-menu-tag tag-${item.category}`}>{item.category}</span>
                </div>
                {item.templateText && (
                  <div className="slash-menu-preview">
                    {item.templateText.replace(/\n+/g, ' ').slice(0, 90)}...
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
