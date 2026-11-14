import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { hasMarkdownSyntax, MarkdownContent } from './markdown';
import { escapeHtml } from './transcriptExport';

/**
 * Renders message text to static HTML with the same Markdown renderer the chat uses,
 * so an exported page looks like the conversation. Copy buttons are removed.
 */
export function renderMessageHtml(text: string): string {
  if (!hasMarkdownSyntax(text)) return `<div class="plain">${escapeHtml(text)}</div>`;
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<MarkdownContent content={text} />));
    host.querySelectorAll('.md-code-copy').forEach((button) => button.remove());
    return host.innerHTML;
  } finally {
    root.unmount();
  }
}
