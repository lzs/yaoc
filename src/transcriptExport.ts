import type { ChatAttachmentItem, ChatMessage, ToolCallItem } from './types';

/** Describes the conversation being exported (shown in the file's header). */
export interface TranscriptMeta {
  title: string;
  agentId: string;
  sessionKey: string;
  exportedAt: Date;
}

export interface TranscriptOptions {
  /** Formats a message time; defaults to the user's locale. */
  formatTime?: (date: Date) => string;
}

export interface HtmlTranscriptOptions extends TranscriptOptions {
  /** Renders message text as an HTML fragment. Defaults to escaped, pre-wrapped text. */
  renderMarkdown?: (text: string) => string;
}

/** Tool arguments and results longer than this are cut short in exports. */
export const TOOL_VALUE_LIMIT = 20_000;

const SAFE_IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/i;

function defaultFormatTime(date: Date): string {
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function validDate(timestamp: number): Date | undefined {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A Markdown code fence longer than any backtick run inside `text`. */
export function codeFence(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function fenced(text: string, language = ''): string {
  const fence = codeFence(text);
  return `${fence}${language}\n${text}\n${fence}`;
}

function roleLabel(message: ChatMessage): string {
  if (message.role === 'user') return 'You';
  if (message.role === 'assistant') return 'Assistant';
  return 'System';
}

function messageNotes(message: ChatMessage): string[] {
  const notes: string[] = [];
  if (message.error) notes.push('failed');
  if (message.streaming) notes.push('still streaming when exported');
  return notes;
}

/** Turns a tool argument or result into text, cutting very long values short. */
export function toolValueText(value: unknown): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length <= TOOL_VALUE_LIMIT) return text;
  const omitted = text.length - TOOL_VALUE_LIMIT;
  return `${text.slice(0, TOOL_VALUE_LIMIT)}\n… (${omitted.toLocaleString('en-US')} more characters not included)`;
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function toolSummary(tool: ToolCallItem): string {
  const parts: string[] = [tool.status === 'error' ? 'failed' : tool.status || 'completed'];
  if (typeof tool.durationMs === 'number' && Number.isFinite(tool.durationMs)) {
    parts.push(
      tool.durationMs < 1000
        ? `${Math.round(tool.durationMs)} ms`
        : `${(tool.durationMs / 1000).toFixed(1)} s`
    );
  }
  if (typeof tool.exitCode === 'number') parts.push(`exit ${tool.exitCode}`);
  return parts.join(' · ');
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentText(attachment: ChatAttachmentItem): string {
  const details = [attachment.mimeType, formatBytes(attachment.sizeBytes)].filter(Boolean);
  return `${attachment.fileName} (${details.join(', ')})`;
}

/** Only inline image data is embedded; remote, blob: and SVG sources are never included. */
export function embeddableImage(attachment: ChatAttachmentItem): string | undefined {
  if (!attachment.isImage) return undefined;
  const candidates = [attachment.previewUrl];
  if (attachment.base64) {
    const b64 = attachment.base64.trim();
    candidates.push(
      b64.startsWith('data:')
        ? b64
        : `data:${attachment.mimeType};base64,${b64.replace(/\s+/g, '')}`
    );
  }
  return candidates.find(
    (url): url is string => typeof url === 'string' && SAFE_IMAGE_DATA_URL_RE.test(url)
  );
}

function exportedTime(meta: TranscriptMeta, formatTime: (date: Date) => string): string {
  return formatTime(meta.exportedAt);
}

export function buildTranscriptMarkdown(
  meta: TranscriptMeta,
  messages: ChatMessage[],
  options: TranscriptOptions = {}
): string {
  const formatTime = options.formatTime ?? defaultFormatTime;
  const out: string[] = [
    `# ${meta.title}`,
    '',
    `- **Agent:** ${meta.agentId}`,
    `- **Session:** \`${meta.sessionKey}\``,
    `- **Exported:** ${exportedTime(meta, formatTime)}`,
    `- **Messages:** ${messages.length}`,
  ];
  for (const message of messages) {
    const date = validDate(message.timestamp);
    const notes = messageNotes(message);
    const heading = [roleLabel(message), date ? formatTime(date) : ''].filter(Boolean).join(' · ');
    out.push('', '---', '', `## ${heading}${notes.length ? ` (${notes.join(', ')})` : ''}`);
    if (message.thinking?.trim()) {
      out.push(
        '',
        '<details>',
        '<summary>Reasoning</summary>',
        '',
        fenced(message.thinking.trim(), 'text'),
        '',
        '</details>'
      );
    }
    if (message.content.trim()) out.push('', message.content.trim());
    for (const attachment of message.attachments ?? []) {
      out.push('', `📎 Attachment: ${attachmentText(attachment)}`);
    }
    for (const tool of message.toolCalls ?? []) {
      out.push('', `**Tool \`${tool.name}\`** — ${toolSummary(tool)}`);
      if (hasValue(tool.args)) out.push('', 'Arguments:', '', fenced(toolValueText(tool.args)));
      if (hasValue(tool.result)) out.push('', 'Result:', '', fenced(toolValueText(tool.result)));
      if (hasValue(tool.error)) out.push('', 'Error:', '', fenced(toolValueText(tool.error)));
    }
  }
  return `${out.join('\n')}\n`;
}

function plainTextHtml(text: string): string {
  return `<div class="plain">${escapeHtml(text)}</div>`;
}

const HTML_STYLES = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#1d2129;--muted:#5f6673;--border:#dde1e7;--code:#f0f2f5;--user:#eef4ff;--accent:#c2410c;--error:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#15171b;--card:#1e2126;--text:#e6e8eb;--muted:#9aa1ad;--border:#30343b;--code:#272b31;--user:#1d2633;--accent:#fb923c;--error:#f97066}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 "Segoe UI",system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}
header h1{font-size:24px;margin:0 0 8px}
.meta{color:var(--muted);font-size:13px;margin:0 0 24px;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:4px 18px}
.meta code{font-size:12px}
article{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 18px;margin:0 0 14px}
article.user{background:var(--user)}
article.error{border-color:var(--error)}
.who{display:flex;gap:10px;align-items:baseline;font-size:13px;color:var(--muted);margin-bottom:6px}
.who strong{color:var(--text);font-size:14px}
.note{color:var(--error)}
.plain{white-space:pre-wrap;overflow-wrap:anywhere}
code,pre{font-family:"Cascadia Code",Consolas,monospace;font-size:13px}
pre{background:var(--code);border-radius:6px;padding:10px 12px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}
.md-inline-code{background:var(--code);border-radius:4px;padding:1px 5px}
.md-code-block{margin:8px 0}
.md-code-header{font-size:12px;color:var(--muted)}
.md-code-copy{display:none}
.md-p{margin:0 0 8px}
.md-blockquote{border-left:3px solid var(--border);margin:8px 0;padding:2px 12px;color:var(--muted)}
.md-table-wrap{overflow-x:auto}
.md-table{border-collapse:collapse;margin:8px 0}
.md-table th,.md-table td{border:1px solid var(--border);padding:4px 10px;text-align:left}
.md-hr{border:0;border-top:1px solid var(--border)}
a{color:var(--accent)}
details{border:1px solid var(--border);border-radius:8px;padding:6px 12px;margin:8px 0}
summary{cursor:pointer;color:var(--muted);font-size:13px}
.label{font-size:12px;color:var(--muted);margin-top:6px}
.attachment{font-size:13px;color:var(--muted);margin:6px 0}
.attachment img{display:block;max-width:100%;max-height:480px;border-radius:6px;margin-top:4px}
`;

export function buildTranscriptHtml(
  meta: TranscriptMeta,
  messages: ChatMessage[],
  options: HtmlTranscriptOptions = {}
): string {
  const formatTime = options.formatTime ?? defaultFormatTime;
  const renderMarkdown = options.renderMarkdown ?? plainTextHtml;
  const articles = messages.map((message) => {
    const date = validDate(message.timestamp);
    const notes = messageNotes(message);
    const parts: string[] = [
      `<div class="who"><strong>${escapeHtml(roleLabel(message))}</strong>` +
        (date
          ? `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(formatTime(date))}</time>`
          : '') +
        (notes.length ? `<span class="note">${escapeHtml(notes.join(', '))}</span>` : '') +
        '</div>',
    ];
    if (message.thinking?.trim()) {
      parts.push(
        `<details><summary>Reasoning</summary><div class="plain">${escapeHtml(message.thinking.trim())}</div></details>`
      );
    }
    if (message.content.trim()) parts.push(renderMarkdown(message.content.trim()));
    for (const attachment of message.attachments ?? []) {
      const image = embeddableImage(attachment);
      parts.push(
        `<div class="attachment">📎 ${escapeHtml(attachmentText(attachment))}` +
          (image
            ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(attachment.fileName)}">`
            : '') +
          '</div>'
      );
    }
    for (const tool of message.toolCalls ?? []) {
      const sections: string[] = [];
      if (hasValue(tool.args))
        sections.push(
          `<div class="label">Arguments</div><pre>${escapeHtml(toolValueText(tool.args))}</pre>`
        );
      if (hasValue(tool.result))
        sections.push(
          `<div class="label">Result</div><pre>${escapeHtml(toolValueText(tool.result))}</pre>`
        );
      if (hasValue(tool.error))
        sections.push(
          `<div class="label">Error</div><pre>${escapeHtml(toolValueText(tool.error))}</pre>`
        );
      parts.push(
        `<details><summary>Tool <code>${escapeHtml(tool.name)}</code> — ${escapeHtml(toolSummary(tool))}</summary>${sections.join('')}</details>`
      );
    }
    const classes = [message.role, message.error ? 'error' : ''].filter(Boolean).join(' ');
    return `<article class="${classes}">${parts.join('\n')}</article>`;
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="generator" content="YAOC">
<title>${escapeHtml(meta.title)}</title>
<style>${HTML_STYLES}</style>
</head>
<body>
<main>
<header>
<h1>${escapeHtml(meta.title)}</h1>
<ul class="meta">
<li>Agent: ${escapeHtml(meta.agentId)}</li>
<li>Session: <code>${escapeHtml(meta.sessionKey)}</code></li>
<li>Exported: ${escapeHtml(exportedTime(meta, formatTime))}</li>
<li>Messages: ${messages.length}</li>
</ul>
</header>
${articles.join('\n')}
</main>
</body>
</html>
`;
}

/** Default file name (without extension) for an export, e.g. "Release notes 2026-11-14". */
export function transcriptBaseName(meta: TranscriptMeta): string {
  const d = meta.exportedAt;
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const title = meta.title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '');
  return `${title || 'conversation'} ${date}`;
}
