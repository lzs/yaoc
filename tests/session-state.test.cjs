// Isolated App handler regression: execute the real hooks/handlers with mocked IPC and time.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const compile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
const modelModule = { exports: {} };
vm.runInNewContext(compile(fs.readFileSync('src/models.ts', 'utf8')), {
  exports: modelModule.exports,
});
let slots = [],
  cursor = 0,
  effects = [],
  timers = new Map(),
  timerId = 0,
  listener,
  statusListener;
const key = (name, agent = 'main') => modelModule.exports.toGatewaySessionKey(agent, name);
const requests = [];
const keydownListeners = new Set();
let shortcutCleanup;
let sendReply = () => Promise.resolve({ runId: 'run-a' });
const api = {
  onStatus(callback) {
    statusListener = callback;
    return () => {};
  },
  getSystemInfo: () => Promise.resolve(null),
  loadProfiles: () => new Promise(() => {}),
  onGatewayEvent(callback) {
    listener = callback;
    return () => {};
  },
  request(method, params) {
    requests.push({ method, params });
    return method === 'chat.send' ? sendReply() : Promise.resolve({ messages: [] });
  },
};
const hooks = {
  useState(initial) {
    const id = cursor++;
    if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial;
    return [
      slots[id],
      (update) => {
        slots[id] = typeof update === 'function' ? update(slots[id]) : update;
      },
    ];
  },
  useRef(initial) {
    const id = cursor++;
    return (slots[id] ??= { current: initial });
  },
  useEffect(callback) {
    effects.push(callback);
  },
  useLayoutEffect() {},
};
const source = fs
  .readFileSync('src/App.tsx', 'utf8')
  .replaceAll(
    'import.meta.url',
    JSON.stringify(
      require('node:url').pathToFileURL(require('node:path').resolve('src/App.tsx')).href
    )
  );
const renderStart = source.indexOf('\n  return (', source.indexOf('export default function App()'));
const testSource =
  source.slice(0, renderStart) +
  `  return { setConnStatus, setComposerText, setPendingAttachments, handleSelectSession, handleSendMessage, handleAbortRun, handleCreateSession, setNewSessionKeyInput, composerText, pendingAttachments, isStreaming, messages, streamingSessionKeys, setSessions, selectedSessionKey, setShowProfileModal, setShowQuitConfirmModal, setIsRecordingHotkey, sessions, setSelectedAgentId }; }`;
const exportsObject = {};
vm.runInNewContext(compile(testSource), {
  exports: exportsObject,
  require(name) {
    if (name === 'react') return hooks;
    if (name === './models') return modelModule.exports;
    if (name === './theme') return { loadTheme: () => 'dark' };
    return {};
  },
  window: {
    openclawApi: api,
    addEventListener(name, callback) {
      if (name === 'keydown') keydownListeners.add(callback);
    },
    removeEventListener(name, callback) {
      if (name === 'keydown') keydownListeners.delete(callback);
    },
  },
  document: { hasFocus: () => true },
  localStorage: { getItem: () => null, setItem() {} },
  setTimeout(callback) {
    timers.set(++timerId, callback);
    return timerId;
  },
  clearTimeout(id) {
    timers.delete(id);
  },
  console,
  Blob,
  URL,
});
let view;
function render() {
  cursor = 0;
  effects = [];
  shortcutCleanup?.();
  view = exportsObject.default();
  effects.find((effect) => effect.toString().includes('const nextUiState ='))();
  shortcutCleanup = effects.find((effect) =>
    effect.toString().includes('setShowQuitConfirmModal')
  )();
  return view;
}
function event(sessionKey, state, extra = {}) {
  listener({ event: 'chat', payload: { sessionKey, state, runId: `run-${sessionKey}`, ...extra } });
  render();
}
(async () => {
  render();
  effects.find((effect) => effect.toString().includes('api.onStatus'))();
  effects.find((effect) => effect.toString().includes('api.onGatewayEvent'))();
  view.setConnStatus({ state: 'connected' });
  render();
  view.setComposerText('send A');
  render();
  await view.handleSendMessage();
  render();
  assert.equal(view.isStreaming, true);
  view.setComposerText('draft A');
  view.setPendingAttachments([{ id: 'attachment-a' }]);
  render();
  view.handleSelectSession('b');
  render();
  assert.equal(view.isStreaming, false, 'A must not block sending in B');
  assert.equal(view.composerText, '', 'A draft must not travel to B');
  assert.equal(view.pendingAttachments.length, 0);
  view.setComposerText('send B');
  render();
  await view.handleSendMessage();
  render();
  event('main', 'final');
  assert.equal(view.isStreaming, true, 'Completion in A must not stop B');
  view.handleSelectSession('main');
  render();
  assert.equal(view.isStreaming, false);
  assert.equal(view.composerText, 'draft A');
  assert.equal(view.pendingAttachments[0].id, 'attachment-a');
  view.handleSelectSession('b');
  render();
  await view.handleAbortRun();
  render();
  assert.equal(
    requests.at(-1).params.runId,
    'run-a',
    'Abort reads the acknowledged session run ID'
  );
  assert.equal(view.isStreaming, false);
  event('b', 'delta');
  listener({
    event: 'agent',
    payload: { sessionKey: 'b', stream: 'lifecycle', data: { phase: 'end' } },
  });
  render();
  assert.equal(view.isStreaming, false, 'Agent lifecycle completion clears busy state');
  event('b', 'delta');
  for (const callback of [...timers.values()]) callback();
  render();
  assert.equal(
    view.isStreaming,
    false,
    'Inactivity fallback clears the composer as well as spinner'
  );
  let rejectSend;
  sendReply = () =>
    new Promise((resolve, reject) => {
      rejectSend = reject;
    });
  view.setComposerText('will fail');
  render();
  const pending = view.handleSendMessage();
  view.handleSelectSession('c');
  render();
  rejectSend(new Error('late failure'));
  await pending;
  render();
  assert.equal(
    view.messages.some((msg) => msg.content.includes('late failure')),
    false
  );
  assert.equal(view.isStreaming, false);
  event('c', 'delta');
  statusListener({ state: 'disconnected' });
  render();
  assert.equal(view.isStreaming, false, 'Unexpected connection loss clears all sessions');
  assert.equal(view.streamingSessionKeys.size, 0);
  // Short names and Gateway-qualified events must identify one live conversation.
  view.setConnStatus({ state: 'connected' });
  sendReply = () => Promise.resolve({ runId: 'run-new' });
  render();
  view.setNewSessionKeyInput('test-2');
  render();
  view.handleCreateSession();
  render();
  assert.equal(view.selectedSessionKey, 'agent:main:test-2');
  assert.equal(view.sessions.filter((session) => session.key === 'agent:main:test-2').length, 1);
  assert.equal(
    view.sessions.find((session) => session.key === 'agent:main:test-2').label,
    'test-2'
  );
  view.setComposerText('Hello');
  render();
  await view.handleSendMessage();
  render();
  assert.equal(
    requests.findLast((request) => request.method === 'chat.send').params.sessionKey,
    'agent:main:test-2'
  );
  event('agent:main:test-2', 'delta', { delta: 'Immediate reply' });
  assert(
    view.messages.some(
      (message) => message.role === 'assistant' && message.content === 'Immediate reply'
    ),
    'Canonical event appears immediately without refreshing history or waiting for a timeout'
  );
  assert.equal(view.sessions.filter((session) => session.key === 'agent:main:test-2').length, 1);
  assert.equal(
    view.sessions.some((session) => session.key === 'test-2'),
    false,
    'No phantom short-name row'
  );
  event('agent:main:test-2', 'final', { message: { content: 'Immediate reply' } });
  assert.equal(view.isStreaming, false, 'Qualified terminal event clears the same spinner');
  assert.equal(view.streamingSessionKeys.has('agent:main:test-2'), false);
  view.setComposerText('Keep this draft');
  view.setPendingAttachments([{ id: 'canonical-attachment' }]);
  render();
  view.handleSelectSession('test-2');
  render();
  assert.equal(
    view.composerText,
    'Keep this draft',
    'Selecting a short alias keeps its canonical draft'
  );
  assert.equal(view.pendingAttachments[0].id, 'canonical-attachment');
  view.setNewSessionKeyInput('agent:main:test-2');
  render();
  view.handleCreateSession();
  render();
  assert.equal(
    view.sessions.filter((session) => session.key === 'agent:main:test-2').length,
    1,
    'Creating an existing alias selects it'
  );
  listener({
    event: 'chat',
    payload: { sessionKey: 'agent:research:test-2', state: 'delta', delta: 'Other agent' },
  });
  render();
  assert.equal(
    view.sessions.some((session) => session.key === 'agent:research:test-2'),
    false,
    'Qualified keys identify their own agent even when agentId is omitted'
  );
  assert.equal(
    view.messages.some((message) => message.content.includes('Other agent')),
    false
  );
  view.setSelectedAgentId('research');
  render();
  view.setNewSessionKeyInput('test-2');
  render();
  view.handleCreateSession();
  render();
  event('agent:research:test-2', 'delta', { delta: 'Research reply' });
  assert(view.messages.some((message) => message.content === 'Research reply'));
  assert.equal(view.selectedSessionKey, 'agent:research:test-2');
  event('agent:research:test-2', 'final');
  assert.equal(view.isStreaming, false);
  view.setSelectedAgentId('main');
  view.setConnStatus({ state: 'disconnected' });
  render();
  console.log(
    'PASS: canonical new sessions, immediate streaming, one sidebar row, draft aliases, terminal cleanup, and cross-agent isolation'
  );

  // Exercise the real window keyboard handler and existing session-selection path.
  function press(key, overrides = {}) {
    let prevented = false;
    const event = {
      key,
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      defaultPrevented: false,
      isComposing: false,
      preventDefault() {
        prevented = true;
      },
      ...overrides,
    };
    for (const listener of [...keydownListeners]) listener(event);
    render();
    return prevented;
  }
  view.setSessions(
    modelModule.exports.normalizeSessions([{ key: 'main' }, { key: 'b' }, { key: 'c' }], 'main')
  );
  view.handleSelectSession('main');
  render();
  view.setComposerText('keyboard draft A');
  render();
  assert.equal(press('PageDown'), true);
  assert.equal(view.selectedSessionKey, key('b'));
  view.setComposerText('keyboard draft B');
  render();
  press('PageUp');
  assert.equal(view.selectedSessionKey, key('main'));
  assert.equal(view.composerText, 'keyboard draft A');
  press('PageUp');
  assert.equal(view.selectedSessionKey, key('c'), 'Previous wraps from first to last');
  press('PageDown');
  assert.equal(view.selectedSessionKey, key('main'), 'Next wraps from last to first');
  for (const overrides of [
    { ctrlKey: false },
    { altKey: true },
    { shiftKey: true },
    { metaKey: true },
    { isComposing: true },
    { defaultPrevented: true },
  ]) {
    assert.equal(press('PageDown', overrides), false);
    assert.equal(view.selectedSessionKey, key('main'));
  }
  for (const setter of ['setShowProfileModal', 'setShowQuitConfirmModal', 'setIsRecordingHotkey']) {
    view[setter](true);
    render();
    assert.equal(press('PageDown'), false);
    assert.equal(view.selectedSessionKey, key('main'), setter + ' suppresses navigation');
    view[setter](false);
    render();
  }
  press('PageDown');
  assert.equal(view.composerText, 'keyboard draft B');
  view.setSessions(modelModule.exports.normalizeSessions([{ key: 'b' }], 'main'));
  render();
  press('PageDown');
  assert.equal(view.selectedSessionKey, key('b'), 'Single-session navigation stays put');
  view.setSessions([]);
  render();
  assert.equal(press('PageUp'), false);
  console.log(
    'PASS: Ctrl+Page Up/Down order, wraparound, drafts, modifiers, modal guards, and empty/single session lists'
  );
  console.log(
    'PASS: session isolation, drafts/attachments, background completion, abort IDs, lifecycle, timeout, delayed failure routing and connection loss'
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
