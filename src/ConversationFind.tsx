import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';

// Search rendered message bodies so Markdown syntax and button labels are excluded.
// Ranges can span inline elements without rewriting the transcript DOM.
export function conversationMatches(container: HTMLElement, query: string): Range[] {
  if (!query) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const matches: Range[] = [];
  for (const body of container.querySelectorAll<HTMLElement>('.message-body')) {
    const nodes: { node: Text; start: number; end: number }[] = [];
    let text = '';
    let previousBlock: Element | null = null;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
      if (!parent || parent.closest('button, .md-code-header, script, style')) continue;
      if (node.nodeType === Node.ELEMENT_NODE) {
        if ((node as Element).tagName === 'BR') text += '\n';
        continue;
      }
      const block =
        parent.closest('p, li, pre, h1, h2, h3, h4, h5, h6, td, th, blockquote') || body;
      if (previousBlock && block !== previousBlock) text += '\n';
      previousBlock = block;
      const start = text.length;
      text += node.textContent || '';
      nodes.push({ node: node as Text, start, end: text.length });
    }
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      const first = nodes.find((part) => part.start <= start && start < part.end);
      const last = nodes.find((part) => part.start < end && end <= part.end);
      if (!first || !last) continue;
      const range = document.createRange();
      range.setStart(first.node, start - first.start);
      range.setEnd(last.node, end - last.start);
      matches.push(range);
    }
  }
  return matches;
}

interface Props {
  containerRef: RefObject<HTMLDivElement | null>;
  focusRequest: number;
  enabled: boolean;
  onClose: () => void;
}

export default function ConversationFind({ containerRef, focusRequest, enabled, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ ranges: Range[]; index: number }>({
    ranges: [],
    index: 0,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  // Live DOM Range offsets reset when React replaces streaming text; retain a snapshot.
  const selectedPosition = useRef<{ node: Node; offset: number } | null>(null);
  const previousQuery = useRef('');
  const revealMatch = useRef(true);

  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, [focusRequest]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let frame = 0;
    const rebuild = () => {
      const ranges = conversationMatches(container, query);
      const selected = selectedPosition.current;
      const retained =
        previousQuery.current === query && selected
          ? ranges.findIndex(
              (range) =>
                range.startContainer === selected.node && range.startOffset === selected.offset
            )
          : -1;
      if (retained < 0) revealMatch.current = true;
      previousQuery.current = query;
      setResults({ ranges, index: retained < 0 ? 0 : retained });
    };
    rebuild();
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(rebuild);
    });
    observer.observe(container, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      CSS.highlights.delete('yaoc-find');
      CSS.highlights.delete('yaoc-find-current');
    };
  }, [containerRef, query]);

  useLayoutEffect(() => {
    const all = new Highlight();
    for (const range of results.ranges) all.add(range);
    CSS.highlights.set('yaoc-find', all);
    const current = results.ranges[results.index];
    selectedPosition.current = current
      ? { node: current.startContainer, offset: current.startOffset }
      : null;
    const active = new Highlight();
    active.priority = 1;
    if (current) active.add(current);
    CSS.highlights.set('yaoc-find-current', active);
    if (!current || !revealMatch.current) return;
    revealMatch.current = false;
    const container = containerRef.current;
    if (!container) return;
    const rect = current.getBoundingClientRect();
    const viewport = container.getBoundingClientRect();
    container.scrollTop += rect.top - viewport.top - container.clientHeight / 2 + rect.height / 2;
    // Reveal matches in horizontally scrolled code blocks as well.
    const pre = current.startContainer.parentElement?.closest('pre');
    if (pre) {
      const bounds = pre.getBoundingClientRect();
      if (rect.left < bounds.left || rect.right > bounds.right)
        pre.scrollLeft += rect.left - bounds.left - pre.clientWidth / 2;
    }
  }, [results, containerRef]);

  function navigate(direction: number) {
    revealMatch.current = true;
    setResults((previous) =>
      previous.ranges.length === 0
        ? previous
        : {
            ...previous,
            index: (previous.index + direction + previous.ranges.length) % previous.ranges.length,
          }
    );
  }

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')
      )
        return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'F3' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        navigate(event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, onClose]);

  return (
    <div className="conversation-find" role="search" aria-label="Find in conversation">
      <Search size={15} aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        className="input-field"
        aria-label="Find in conversation"
        aria-describedby="conversation-find-scope"
        placeholder="Find in conversation…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            navigate(event.shiftKey ? -1 : 1);
          }
        }}
      />
      <span id="conversation-find-scope" className="conversation-find-scope">
        Searches message text and code currently loaded in this conversation.
      </span>
      <span className="conversation-find-count" role="status" aria-live="polite" aria-atomic="true">
        {!query
          ? 'Type to find'
          : results.ranges.length
            ? `${results.index + 1} of ${results.ranges.length}`
            : 'No matches'}
      </span>
      <div className="conversation-find-actions">
        <button
          type="button"
          className="btn"
          aria-label="Previous match"
          title="Previous match (Shift+Enter / Shift+F3)"
          disabled={!results.ranges.length}
          onClick={() => navigate(-1)}
        >
          <ChevronUp size={15} />
        </button>
        <button
          type="button"
          className="btn"
          aria-label="Next match"
          title="Next match (Enter / F3)"
          disabled={!results.ranges.length}
          onClick={() => navigate(1)}
        >
          <ChevronDown size={15} />
        </button>
        <button
          type="button"
          className="btn"
          aria-label="Close find"
          title="Close find (Esc)"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
