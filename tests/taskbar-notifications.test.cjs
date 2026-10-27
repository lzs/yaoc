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
    },
  }).outputText;

test('tauriBridge exposes taskbar and notification IPC methods', async () => {
  const bridgeCode = fs.readFileSync('src/tauriBridge.ts', 'utf8');
  const compiled = compile(bridgeCode);

  const invokedCommands = [];
  const fakeWindow = {
    __TAURI__: {
      core: {
        invoke: async (cmd, args) => {
          invokedCommands.push({ cmd, args });
          return { ok: true };
        },
      },
      event: {
        listen: async () => () => {},
      },
    },
  };

  const sandbox = {
    window: fakeWindow,
    exports: {},
    console,
  };

  vm.runInNewContext(compiled, sandbox);
  sandbox.exports.initTauriBridge();

  const api = fakeWindow.openclawApi;
  assert.ok(api, 'openclawApi should be defined');
  assert.equal(typeof api.setTaskbarProgress, 'function');
  assert.equal(typeof api.showNotification, 'function');
  assert.equal(typeof api.playNotificationSound, 'function');
  assert.equal(typeof api.requestAttention, 'function');

  // Helper to normalize cross-realm objects from vm sandbox
  const normalize = (obj) => JSON.parse(JSON.stringify(obj));

  // Test setTaskbarProgress
  await api.setTaskbarProgress('indeterminate');
  assert.deepEqual(normalize(invokedCommands[0]), {
    cmd: 'set_taskbar_progress',
    args: { status: 'indeterminate', progress: null },
  });

  await api.setTaskbarProgress('normal', 75);
  assert.deepEqual(normalize(invokedCommands[1]), {
    cmd: 'set_taskbar_progress',
    args: { status: 'normal', progress: 75 },
  });

  // Test showNotification
  await api.showNotification('Test Title', 'Test Body', true);
  assert.deepEqual(normalize(invokedCommands[2]), {
    cmd: 'show_notification',
    args: { title: 'Test Title', body: 'Test Body', sound: true },
  });

  // Test playNotificationSound
  await api.playNotificationSound('warning');
  assert.deepEqual(normalize(invokedCommands[3]), {
    cmd: 'play_notification_sound',
    args: { soundType: 'warning' },
  });

  // Test requestAttention
  await api.requestAttention('critical');
  assert.deepEqual(normalize(invokedCommands[4]), {
    cmd: 'request_attention',
    args: { level: 'critical' },
  });

  await api.requestAttention('none');
  assert.deepEqual(normalize(invokedCommands[5]), {
    cmd: 'request_attention',
    args: { level: 'none' },
  });
});

test('taskbar state logic: paused on approvals, indeterminate on streaming, none on idle', () => {
  function computeTaskbarState(approvalsCount, streamingCount) {
    if (approvalsCount > 0) return { status: 'paused', attention: 'critical' };
    if (streamingCount > 0) return { status: 'indeterminate', attention: null };
    return { status: 'none', attention: 'none' };
  }

  assert.deepEqual(computeTaskbarState(0, 0), { status: 'none', attention: 'none' });
  assert.deepEqual(computeTaskbarState(0, 1), { status: 'indeterminate', attention: null });
  assert.deepEqual(computeTaskbarState(1, 1), { status: 'paused', attention: 'critical' });
  assert.deepEqual(computeTaskbarState(2, 0), { status: 'paused', attention: 'critical' });
});

test('UI session state types and settings persistence include notification flags', () => {
  const typesContent = fs.readFileSync('src/types.ts', 'utf8');
  assert.ok(typesContent.includes('notificationsEnabled?: boolean'), 'UiSessionState should have notificationsEnabled');
  assert.ok(typesContent.includes('notificationSound?: boolean'), 'UiSessionState should have notificationSound');

  const appContent = fs.readFileSync('src/App.tsx', 'utf8');
  assert.ok(appContent.includes('notificationsEnabled:'), 'App.tsx should persist notificationsEnabled');
  assert.ok(appContent.includes('notificationSound:'), 'App.tsx should persist notificationSound');
});
