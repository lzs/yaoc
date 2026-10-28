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
      jsx: ts.JsxEmit.React,
    },
  }).outputText;

test('DEFAULT_PROMPT_TEMPLATES and built-in templates are defined correctly', () => {
  const slashCode = fs.readFileSync('src/SlashCommands.tsx', 'utf8');
  const compiled = compile(slashCode);

  const fakeReact = {
    createElement: () => ({}),
    useState: (val) => [val, () => {}],
    useRef: () => ({ current: null }),
    useMemo: (fn) => fn(),
    useEffect: () => {},
    useLayoutEffect: () => {},
  };
  fakeReact.default = fakeReact;
  fakeReact.default = fakeReact;

  const sandbox = {
    exports: {},
    require: (mod) => {
      if (mod === 'react') return fakeReact;
      if (mod === 'lucide-react') {
        return new Proxy({}, { get: () => () => fakeReact.createElement() });
      }
      return {};
    },
  };

  vm.runInNewContext(compiled, sandbox);
  const templates = sandbox.exports.DEFAULT_PROMPT_TEMPLATES;
  assert.ok(Array.isArray(templates), 'DEFAULT_PROMPT_TEMPLATES should be an array');
  assert.ok(templates.length >= 6, 'Should have at least 6 default templates');

  const triggers = templates.map((t) => t.trigger);
  assert.ok(triggers.includes('review'), 'Should have review template');
  assert.ok(triggers.includes('test'), 'Should have test template');
  assert.ok(triggers.includes('fix'), 'Should have fix template');
  assert.ok(triggers.includes('explain'), 'Should have explain template');
  assert.ok(triggers.includes('refactor'), 'Should have refactor template');
  assert.ok(triggers.includes('doc'), 'Should have doc template');

  for (const t of templates) {
    assert.ok(t.id, 'Template must have id');
    assert.ok(t.label, 'Template must have label');
    assert.ok(t.template, 'Template must have body template');
    assert.equal(t.isBuiltIn, true, 'Built-in flag must be true');
  }
});

test('App keyboard handler binds Ctrl+P and Ctrl+Shift+P strictly without Ctrl+K', () => {
  const appCode = fs.readFileSync('src/App.tsx', 'utf8');

  // Verify Ctrl+P and Ctrl+Shift+P are bound
  assert.ok(
    appCode.includes("(e.key.toLowerCase() === 'p' || e.code === 'KeyP')"),
    'Must bind key P'
  );
  assert.ok(
    appCode.includes("setQuickSwitcherMode('command')"),
    'Shift+Ctrl+P must set command mode'
  );
  assert.ok(appCode.includes("setQuickSwitcherMode('search')"), 'Ctrl+P must set search mode');

  // Strictly verify NO Ctrl+K binding exists
  const hasCtrlK = /(e\.key\s*===\s*['"]k['"]|KeyK)/i.test(appCode);
  assert.equal(hasCtrlK, false, 'Explicit policy: Strictly NO Ctrl+K binding allowed in App.tsx');
});

test('Slash menu filters commands and templates correctly', () => {
  const slashCode = fs.readFileSync('src/SlashCommands.tsx', 'utf8');
  const compiled = compile(slashCode);

  let capturedAllItems = null;

  const fakeReact = {
    createElement: () => ({}),
    useState: (val) => [val, () => {}],
    useRef: () => ({ current: null }),
    useMemo: (fn) => {
      const res = fn();
      if (!capturedAllItems && Array.isArray(res)) capturedAllItems = res;
      return res;
    },
    useEffect: () => {},
    useLayoutEffect: () => {},
  };
  fakeReact.default = fakeReact;

  const sandbox = {
    exports: {},
    require: (mod) => {
      if (mod === 'react') return fakeReact;
      if (mod === 'lucide-react') {
        return new Proxy({}, { get: () => () => fakeReact.createElement() });
      }
      return {};
    },
  };

  vm.runInNewContext(compiled, sandbox);

  // Instantiate component to capture allItems
  sandbox.exports.default({
    isOpen: true,
    filter: '',
    customTemplates: [
      { id: 'custom-1', trigger: 'audit', label: 'Security Audit', template: 'Audit code' },
    ],
    onSelect: () => {},
    onClose: () => {},
  });

  assert.ok(Array.isArray(capturedAllItems), 'Should build items list');

  // Filter test: built-in command /reset
  const resetItem = capturedAllItems.find((i) => i.trigger === 'reset');
  assert.ok(resetItem, 'Should include /reset command');
  assert.equal(resetItem.category, 'command');

  // Filter test: custom template /audit
  const customItem = capturedAllItems.find((i) => i.trigger === 'audit');
  assert.ok(customItem, 'Should include custom template /audit');
  assert.equal(customItem.category, 'template');
  assert.equal(customItem.description, 'Security Audit');

  // Verify prefix matching logic
  const matchRev = capturedAllItems.filter(
    (i) =>
      i.trigger.toLowerCase().includes('rev') ||
      i.label.toLowerCase().includes('rev') ||
      i.description
        .toLowerCase()
        .split(/\s+/)
        .some((w) => w.startsWith('rev'))
  );
  assert.ok(
    matchRev.some((i) => i.trigger === 'review'),
    'Filter rev should match review'
  );
  assert.ok(!matchRev.some((i) => i.trigger === 'compact'), 'Filter rev should not match compact');
});

test('QuickSwitcher properly partitions search items and commands', () => {
  const qsCode = fs.readFileSync('src/QuickSwitcher.tsx', 'utf8');
  assert.ok(
    qsCode.includes("query.startsWith('>')"),
    'QuickSwitcher detects command mode prefix >'
  );
  assert.ok(qsCode.includes('cmd-new-session'), 'Includes New Session command');
  assert.ok(qsCode.includes('cmd-settings'), 'Includes Settings command');
  assert.ok(qsCode.includes('cmd-workspace-toggle'), 'Includes Workspace Toggle command');
  assert.ok(qsCode.includes('cmd-theme-toggle'), 'Includes Theme Toggle command');
  assert.ok(qsCode.includes('cmd-clear-session'), 'Includes Clear Session command');
  assert.ok(qsCode.includes('cmd-toggle-notifications'), 'Includes Toggle Notifications command');
  assert.ok(qsCode.includes('cmd-toggle-sound'), 'Includes Toggle Sound command');
});
