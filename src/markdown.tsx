import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';

const MARKDOWN_PATTERNS: RegExp[] = [
  /```[\s\S]*?```/, // Fenced code block (closed)
  /(?:^|\n)\s{0,3}```/, // Fenced code block (open/streaming)
  /`[^`\n]+`/, // Inline code
  /(?:^|\n)\s{0,3}#{1,6}\s+\S/, // Headings (# .. ######)
  /\*\*[^*\n]+\*\*/, // Bold **text**
  /__[^_\n]+__/, // Bold __text__
  /(?:^|[\s(])\*[^*\s][^*\n]*\*(?=$|[\s.,!?:;)])/, // Italic *text*
  /(?:^|[\s(])_[^_\s][^_\n]*_(?=$|[\s.,!?:;)])/, // Italic _text_
  /~~[^~\n]+~~/, // Strikethrough ~~text~~
  /\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^\s)]+\)/, // Links [text](url)
  /(?:^|\n)\s{0,3}>\s+\S/, // Blockquote > text
  /(?:^|\n)\s{0,3}[-*+]\s+\S/, // Unordered list
  /(?:^|\n)\s{0,3}\d+\.\s+\S/, // Ordered list
  /(?:^|\n)\s{0,3}(?:---|\*\*\*|___)\s*(?:\n|$)/, // Horizontal rule
  /(?:^|\n)\|[^\n]+\|\s*\n\s*\|?\s*:?-{3,}:?\s*\|/, // GFM table
];

export function hasMarkdownSyntax(text: string): boolean {
  if (!text || text.length < 3) return false;
  return MARKDOWN_PATTERNS.some((re) => re.test(text));
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="md-code-block">
      <div className="md-code-header">
        <span className="md-code-lang">{language || 'code'}</span>
        <button type="button" className="md-code-copy" onClick={handleCopy} title="Copy code block">
          {copied ? (
            <>
              <Check size={12} /> Copied
            </>
          ) : (
            <>
              <Copy size={12} /> Copy
            </>
          )}
        </button>
      </div>
      <pre className="md-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const INLINE_TOKEN_RE =
  /(`[^`\n]+`|\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^\s)]+\)|(?<=^|[\s(])\*[^*\s][^*\n]*\*(?=$|[\s.,!?:;)])|(?<=^|[\s(])_[^_\s][^_\n]*_(?=$|[\s.,!?:;)]))/g;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(INLINE_TOKEN_RE);
  return parts.map((part, idx) => {
    if (!part) return null;
    const key = `${keyPrefix}-${idx}`;

    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code key={key} className="md-inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('***') && part.endsWith('***') && part.length > 6) {
      return (
        <strong key={key}>
          <em>{renderInline(part.slice(3, -3), key)}</em>
        </strong>
      );
    }
    if (
      (part.startsWith('**') && part.endsWith('**')) ||
      (part.startsWith('__') && part.endsWith('__'))
    ) {
      return <strong key={key}>{renderInline(part.slice(2, -2), key)}</strong>;
    }
    if (part.startsWith('~~') && part.endsWith('~~') && part.length > 4) {
      return <del key={key}>{renderInline(part.slice(2, -2), key)}</del>;
    }
    if (
      (part.startsWith('*') && part.endsWith('*')) ||
      (part.startsWith('_') && part.endsWith('_'))
    ) {
      return <em key={key}>{renderInline(part.slice(1, -1), key)}</em>;
    }
    if (part.startsWith('[')) {
      const match = part.match(/^\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)$/);
      if (match) {
        const href = match[2];
        const handleLinkClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
          if (window.openclawApi?.openExternalUrl) {
            e.preventDefault();
            window.openclawApi.openExternalUrl(href).catch((err) => {
              console.error('Failed to open external URL:', err);
            });
          }
        };
        return (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="md-link"
            onClick={handleLinkClick}
          >
            {match[1]}
          </a>
        );
      }
    }
    return part;
  });
}

function renderInlineWithBreaks(text: string, keyPrefix: string): React.ReactNode {
  const lines = text.split('\n');
  return lines.map((line, i) => (
    <React.Fragment key={`${keyPrefix}-ln-${i}`}>
      {i > 0 && <br />}
      {renderInline(line, `${keyPrefix}-l${i}`)}
    </React.Fragment>
  ));
}

function parseTableCells(row: string): string[] {
  const trimmed = row.trim().replace(/^\||\|$/g, '');
  return trimmed.split('|').map((c) => c.trim());
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') && !trimmed.includes('-')) return false;
  const cells = parseTableCells(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

export function MarkdownContent({ content }: { content: string }) {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let blockIdx = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 1. Blank lines
    if (line.trim() === '') {
      i++;
      continue;
    }

    // 2. Fenced code block (``` or ~~~)
    const fenceMatch = line.match(/^\s{0,3}(```+|~~~+)\s*([^\s`~]*)\s*$/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = fenceMatch[2] || '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        if (new RegExp(`^\\s{0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[i])) {
          i++;
          break;
        }
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push(
        <CodeBlock key={`b-${blockIdx++}`} language={lang} code={codeLines.join('\n')} />
      );
      continue;
    }

    // 3. Horizontal rule
    if (/^\s{0,3}(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      blocks.push(<hr key={`b-${blockIdx++}`} className="md-hr" />);
      i++;
      continue;
    }

    // 4. ATX Heading (# to ######)
    const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      const bKey = `b-${blockIdx++}`;
      blocks.push(
        <Tag key={bKey} className={`md-heading md-h${level}`}>
          {renderInline(headingMatch[2], bKey)}
        </Tag>
      );
      i++;
      continue;
    }

    // 5. GFM Table
    if (line.includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
      const headerCells = parseTableCells(line);
      i += 2; // Skip header + separator
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        bodyRows.push(parseTableCells(lines[i]));
        i++;
      }
      const bKey = `b-${blockIdx++}`;
      blocks.push(
        <div key={bKey} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {headerCells.map((cell, cIdx) => (
                  <th key={`${bKey}-th-${cIdx}`}>{renderInline(cell, `${bKey}-th-${cIdx}`)}</th>
                ))}
              </tr>
            </thead>
            {bodyRows.length > 0 && (
              <tbody>
                {bodyRows.map((row, rIdx) => (
                  <tr key={`${bKey}-tr-${rIdx}`}>
                    {headerCells.map((_, cIdx) => (
                      <td key={`${bKey}-td-${rIdx}-${cIdx}`}>
                        {renderInline(row[cIdx] || '', `${bKey}-td-${rIdx}-${cIdx}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      );
      continue;
    }

    // 6. Blockquote (> ...)
    if (/^\s{0,3}>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i++;
      }
      const bKey = `b-${blockIdx++}`;
      blocks.push(
        <blockquote key={bKey} className="md-blockquote">
          <MarkdownContent content={quoteLines.join('\n')} />
        </blockquote>
      );
      continue;
    }

    // 7. Unordered or Ordered List
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (ulMatch || olMatch) {
      const isOrdered = Boolean(olMatch);
      const startNum = olMatch ? parseInt(olMatch[2], 10) : 1;
      const items: { text: string; checked?: boolean }[] = [];

      while (i < lines.length) {
        const cur = lines[i];
        const curUl = cur.match(/^(\s*)[-*+]\s+(.*)$/);
        const curOl = cur.match(/^(\s*)(\d+)\.\s+(.*)$/);
        if (isOrdered ? !curOl : !curUl) break;

        let itemText = isOrdered ? curOl![3] : curUl![2];
        let checked: boolean | undefined;
        const taskMatch = itemText.match(/^\[([ xX])\]\s+(.*)$/);
        if (taskMatch) {
          checked = taskMatch[1].toLowerCase() === 'x';
          itemText = taskMatch[2];
        }
        i++;

        // Collect continuation lines indented under this list item
        while (
          i < lines.length &&
          lines[i].trim() !== '' &&
          !/^(\s*)[-*+]\s+/.test(lines[i]) &&
          !/^(\s*)\d+\.\s+/.test(lines[i]) &&
          !/^\s{0,3}(```|~~~|#{1,6}\s|>\s)/.test(lines[i]) &&
          /^\s{2,}/.test(lines[i])
        ) {
          itemText += '\n' + lines[i].trim();
          i++;
        }

        items.push({ text: itemText, checked });
      }

      const bKey = `b-${blockIdx++}`;
      const ListTag = isOrdered ? 'ol' : 'ul';
      blocks.push(
        <ListTag
          key={bKey}
          className="md-list"
          {...(isOrdered && startNum !== 1 ? { start: startNum } : {})}
        >
          {items.map((item, idx) => (
            <li
              key={`${bKey}-li-${idx}`}
              className={typeof item.checked === 'boolean' ? 'md-task-item' : undefined}
            >
              {typeof item.checked === 'boolean' && (
                <input
                  type="checkbox"
                  checked={item.checked}
                  readOnly
                  className="md-task-checkbox"
                />
              )}
              <span>{renderInlineWithBreaks(item.text, `${bKey}-li-${idx}`)}</span>
            </li>
          ))}
        </ListTag>
      );
      continue;
    }

    // 8. Paragraph (consume consecutive non-special lines)
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^\s{0,3}(```+|~~~+)/.test(lines[i]) &&
      !/^\s{0,3}(#{1,6})\s+/.test(lines[i]) &&
      !/^\s{0,3}(?:---+|___+|\*\*\*+)\s*$/.test(lines[i]) &&
      !/^\s{0,3}>\s?/.test(lines[i]) &&
      !/^(\s*)[-*+]\s+/.test(lines[i]) &&
      !/^(\s*)\d+\.\s+/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    const bKey = `b-${blockIdx++}`;
    blocks.push(
      <p key={bKey} className="md-p">
        {renderInlineWithBreaks(paraLines.join('\n'), bKey)}
      </p>
    );
  }

  return <div className="md-content">{blocks}</div>;
}
