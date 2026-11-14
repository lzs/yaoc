const { test } = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const fs = require('node:fs');
const vm = require('node:vm');

const mod = {};
vm.runInNewContext(
  ts.transpileModule(fs.readFileSync('src/transcriptExport.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  { exports: mod, require: () => ({}) }
);
const {
  buildTranscriptMarkdown,
  buildTranscriptHtml,
  codeFence,
  embeddableImage,
  toolValueText,
  transcriptBaseName,
  TOOL_VALUE_LIMIT,
} = mod;

const meta = {
  title: 'Release notes',
  agentId: 'main',
  sessionKey: 'release',
  exportedAt: new Date(2026, 10, 14, 9, 5),
};
const formatTime = (d) => d.toISOString();
const messages = [
  { id: '1', role: 'user', content: 'Summarise **this**', timestamp: Date.UTC(2026, 10, 14, 1) },
  {
    id: '2',
    role: 'assistant',
    content: 'Here is code:\n```js\nx()\n```',
    thinking: 'Plan it',
    timestamp: Date.UTC(2026, 10, 14, 2),
    toolCalls: [
      {
        id: 't',
        name: 'exec',
        status: 'completed',
        args: { command: 'npm test' },
        result: 'ok',
        exitCode: 0,
        durationMs: 1500,
      },
    ],
  },
  { id: '3', role: 'assistant', content: 'Boom', error: true, timestamp: NaN },
];

test('Markdown export keeps text, reasoning, tools and safe fences', () => {
  const md = buildTranscriptMarkdown(meta, messages, { formatTime });
  assert.match(md, /^# Release notes\n/);
  assert.match(md, /- \*\*Messages:\*\* 3/);
  assert.match(md, /## You · 2026-11-14T01:00:00.000Z\n\nSummarise \*\*this\*\*/);
  assert.match(md, /<summary>Reasoning<\/summary>\n\n```text\nPlan it\n```/);
  assert.match(md, /\*\*Tool `exec`\*\* — completed · 1\.5 s · exit 0/);
  assert.match(md, /Arguments:\n\n```\n\{\n {2}"command": "npm test"\n\}\n```/);
  assert.match(md, /## Assistant \(failed\)\n\nBoom/);
  assert.equal(codeFence('a ``` b ```` c'), '`````');
  assert.equal(codeFence('plain'), '```');
});

test('HTML export escapes content, blocks scripts and embeds only inline images', () => {
  const html = buildTranscriptHtml(
    { ...meta, title: '<script>alert(1)</script>' },
    [
      {
        id: 'x',
        role: 'user',
        content: '<img src=x onerror=alert(1)>',
        timestamp: 0,
        attachments: [
          {
            id: 'a',
            fileName: 'shot.png',
            mimeType: 'image/png',
            sizeBytes: 2048,
            origin: 'paste',
            isImage: true,
            base64: 'iVBORw0KGgo=',
          },
          {
            id: 'b',
            fileName: 'remote.png',
            mimeType: 'image/png',
            sizeBytes: 10,
            origin: 'file',
            isImage: true,
            previewUrl: 'https://example.com/x.png',
          },
        ],
      },
    ],
    { formatTime }
  );
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<img src="data:image\/png;base64,iVBORw0KGgo=" alt="shot.png">/);
  assert.match(html, /remote\.png \(image\/png, 10 B\)<\/div>/);
  assert.doesNotMatch(html, /example\.com/);
});

test('HTML export uses the supplied Markdown renderer for message text only', () => {
  const html = buildTranscriptHtml(meta, messages, {
    formatTime,
    renderMarkdown: (text) => `<div class="md">${text.length}</div>`,
  });
  assert.match(html, /<div class="md">18<\/div>/);
  assert.match(html, /<summary>Tool <code>exec<\/code> — completed · 1\.5 s · exit 0<\/summary>/);
  assert.match(html, /<div class="plain">Plan it<\/div>/);
});

test('long tool output is cut short and names are safe for Windows', () => {
  const text = toolValueText('x'.repeat(TOOL_VALUE_LIMIT + 5));
  assert.ok(text.startsWith('x'.repeat(TOOL_VALUE_LIMIT)));
  assert.match(text, /5 more characters not included\)$/);
  assert.equal(toolValueText({ a: 1 }), '{\n  "a": 1\n}');
  assert.equal(transcriptBaseName({ ...meta, title: 'a/b: c?.' }), 'a_b_ c_ 2026-11-14');
  assert.equal(transcriptBaseName({ ...meta, title: '   ' }), 'conversation 2026-11-14');
  assert.equal(
    embeddableImage({ isImage: true, mimeType: 'image/svg+xml', base64: 'PHN2Zz4=' }),
    undefined
  );
});
