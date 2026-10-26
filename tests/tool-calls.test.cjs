const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');

const compile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;

// Load App.tsx functions or ToolCallCard helpers for testing
const appCode = fs.readFileSync('src/App.tsx', 'utf8');

test('extractToolCallsFromRaw extracts direct toolCalls array', () => {
  const sandbox = {
    exports: {},
    console,
  };
  // Extract and evaluate extractToolCallsFromRaw
  const fnMatch = appCode.match(/function extractToolCallsFromRaw[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'extractToolCallsFromRaw should be found');
  const safeParseMatch = appCode.match(/function safeParseJson[\s\S]*?\n\}/);
  assert.ok(safeParseMatch, 'safeParseJson should be found');

  const compiledCode = compile(
    safeParseMatch[0] + '\n' + fnMatch[0] + '\nexports.extract = extractToolCallsFromRaw;'
  );
  vm.runInNewContext(compiledCode, sandbox);

  const rawMsg = {
    toolCalls: [
      {
        id: 'tc-1',
        name: 'exec',
        args: { command: 'git status' },
        result: 'On branch main',
        exitCode: 0,
        durationMs: 45,
      },
      {
        id: 'tc-2',
        name: 'read_file',
        args: { path: 'src/App.tsx' },
        error: 'File not found',
        status: 'error',
      },
    ],
  };

  const tools = sandbox.exports.extract(rawMsg);
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, 'exec');
  assert.equal(tools[0].args.command, 'git status');
  assert.equal(tools[0].result, 'On branch main');
  assert.equal(tools[0].exitCode, 0);
  assert.equal(tools[0].durationMs, 45);
  assert.equal(tools[0].status, 'completed');

  assert.equal(tools[1].name, 'read_file');
  assert.equal(tools[1].status, 'error');
  assert.equal(tools[1].error, 'File not found');
});

test('extractToolCallsFromRaw extracts Anthropic-style content blocks', () => {
  const sandbox = { exports: {} };
  const fnMatch = appCode.match(/function extractToolCallsFromRaw[\s\S]*?\n\}/);
  const safeParseMatch = appCode.match(/function safeParseJson[\s\S]*?\n\}/);

  const compiledCode = compile(
    safeParseMatch[0] + '\n' + fnMatch[0] + '\nexports.extract = extractToolCallsFromRaw;'
  );
  vm.runInNewContext(compiledCode, sandbox);

  const rawMsg = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Inspecting directory' },
      {
        type: 'tool_use',
        id: 'toolu_01',
        name: 'bash',
        input: { command: 'ls -la' },
      },
    ],
  };

  const tools = sandbox.exports.extract(rawMsg);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].id, 'toolu_01');
  assert.equal(tools[0].name, 'bash');
  assert.equal(tools[0].args.command, 'ls -la');
  assert.equal(tools[0].status, 'completed');
});

test('extractThinkingText handles both string and content block forms', () => {
  const sandbox = { exports: {} };
  const fnMatch = appCode.match(/function extractThinkingText[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'extractThinkingText should be found');

  const compiledCode = compile(fnMatch[0] + '\nexports.extractThinking = extractThinkingText;');
  vm.runInNewContext(compiledCode, sandbox);

  // Direct string property
  assert.equal(sandbox.exports.extractThinking({ thinking: 'Thinking step' }), 'Thinking step');

  // Array of blocks
  const blockMsg = {
    content: [
      { type: 'thinking', thinking: 'Step 1: plan' },
      { type: 'thinking', thinking: 'Step 2: execute' },
      { type: 'text', text: 'Answer' },
    ],
  };
  assert.equal(
    sandbox.exports.extractThinking(blockMsg),
    'Step 1: plan\nStep 2: execute'
  );

  // None
  assert.equal(sandbox.exports.extractThinking({ content: 'Just text' }), undefined);
});

test('ToolCallCard helper extracts primary argument summary', () => {
  const cardCode = fs.readFileSync('src/ToolCallCard.tsx', 'utf8');
  const sandbox = { exports: {} };
  const fnMatch = cardCode.match(/function extractPrimaryArg[\s\S]*?\n\}/);
  const durMatch = cardCode.match(/function formatDuration[\s\S]*?\n\}/);
  const catMatch = cardCode.match(/function getToolCategory[\s\S]*?\n\}/);
  assert.ok(fnMatch && durMatch && catMatch);

  const compiledCode = compile(
    fnMatch[0] +
      '\n' +
      durMatch[0] +
      '\n' +
      catMatch[0] +
      '\nexports.extractArg = extractPrimaryArg; exports.formatDuration = formatDuration; exports.getCategory = getToolCategory;'
  );
  vm.runInNewContext(compiledCode, sandbox);

  // Command preview
  assert.equal(sandbox.exports.extractArg({ command: 'cargo test --lib' }), 'cargo test --lib');
  assert.equal(sandbox.exports.extractArg({ path: 'src/main.rs' }), 'src/main.rs');
  assert.equal(sandbox.exports.extractArg({ query: 'openclaw gateway protocol' }), 'openclaw gateway protocol');
  assert.equal(sandbox.exports.extractArg('echo hello'), 'echo hello');

  // Duration formatting
  assert.equal(sandbox.exports.formatDuration(35), '35ms');
  assert.equal(sandbox.exports.formatDuration(1500), '1.50s');
  assert.equal(sandbox.exports.formatDuration(65000), '1.1m');
  assert.equal(sandbox.exports.formatDuration(undefined), null);

  // Tool categories
  assert.equal(sandbox.exports.getCategory('bash'), 'shell');
  assert.equal(sandbox.exports.getCategory('exec'), 'shell');
  assert.equal(sandbox.exports.getCategory('run_command'), 'shell');
  assert.equal(sandbox.exports.getCategory('read_file'), 'file');
  assert.equal(sandbox.exports.getCategory('write_file'), 'file');
  assert.equal(sandbox.exports.getCategory('browser_click'), 'web');
  assert.equal(sandbox.exports.getCategory('custom_tool'), 'other');
});
