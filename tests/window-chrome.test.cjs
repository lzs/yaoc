const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

test('window bridge dispatches native actions and cleans up delayed state subscriptions', async () => {
  const calls = [];
  let listener;
  let finishListen;
  let cleaned = 0;
  const sandbox = {
    exports: {},
    window: {
      __TAURI__: {
        core: {
          invoke: async (command, args) => {
            calls.push({ command, args });
            return command === 'get_window_maximized';
          },
        },
        event: {
          listen: (name, callback) => {
            assert.equal(name, 'window:maximized');
            listener = callback;
            return new Promise((resolve) => {
              finishListen = () =>
                resolve(() => {
                  cleaned++;
                });
            });
          },
        },
      },
    },
  };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync('src/tauriBridge.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    sandbox
  );
  sandbox.exports.initTauriBridge();
  const api = sandbox.window.openclawApi;
  for (const action of ['startDragging', 'minimize', 'toggleMaximize', 'close'])
    await api.windowAction(action);
  assert.equal(await api.getWindowMaximized(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ...['startDragging', 'minimize', 'toggleMaximize', 'close'].map((action) => ({
      command: 'window_action',
      args: { action },
    })),
    { command: 'get_window_maximized' },
  ]);
  const states = [];
  const stop = api.onWindowMaximized((value) => states.push(value));
  listener({ payload: true });
  stop();
  listener({ payload: false });
  finishListen();
  await Promise.resolve();
  assert.deepEqual(states, [true]);
  assert.equal(cleaned, 1);
  assert.equal(sandbox.window.__TAURI__, undefined);
});
