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
const requests = [];
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
  `  return { setConnStatus, setComposerText, setPendingAttachments, handleSelectSession, handleSendMessage, handleAbortRun, handleCreateSession, setNewSessionKeyInput, composerText, pendingAttachments, isStreaming, messages, streamingSessionKeys }; }`;
const exportsObject = {};
vm.runInNewContext(compile(testSource), {
  exports: exportsObject,
  require(name) {
    if (name === 'react') return hooks;
    if (name === './models') return modelModule.exports;
    if (name === './theme') return { loadTheme: () => 'dark' };
    return {};
  },
  window: { openclawApi: api, addEventListener() {}, removeEventListener() {} },
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
  view = exportsObject.default();
  effects.find((effect) => effect.toString().includes('const nextUiState ='))();
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
  console.log(
    'PASS: session isolation, drafts/attachments, background completion, abort IDs, lifecycle, timeout, delayed failure routing and connection loss'
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
