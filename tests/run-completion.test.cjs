const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function fixture() {
  const timers = new Map();
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync('src/runCompletion.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports: module.exports,
      setTimeout(callback) {
        const id = Symbol();
        timers.set(id, callback);
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    }
  );
  const waits = new Map();
  const busy = new Map();
  const completed = [];
  const tracker = new module.exports.RunCompletionTracker(
    (id) => new Promise((resolve, reject) => waits.set(id, { resolve, reject })),
    (key, active) => busy.set(key, active),
    (key) => completed.push(key)
  );
  const event = (id, state = 'delta', extra = {}) =>
    tracker.event('session', 'chat', { runId: id, state, ...extra });
  const result = async (id, status) => {
    await settle();
    waits.get(id).resolve({ status });
    await settle();
  };
  return { tracker, timers, waits, busy, completed, event, result };
}

test('partial finals and tool boundaries do not complete a run; wait timeouts keep it busy', async () => {
  const f = fixture();
  f.event('run');
  f.event('run', 'final');
  f.tracker.event('session', 'agent', { runId: 'run', stream: 'tool', phase: 'end' });
  await f.result('run', 'timeout');
  assert.equal(f.busy.get('session'), true);
  assert.equal(f.completed.length, 0);
  assert.equal(f.timers.size, 1);
  const retry = [...f.timers.values()][0];
  f.timers.clear();
  retry();
  f.event('run', 'delta');
  await f.result('run', 'ok');
  assert.equal(f.busy.get('session'), false);
  assert.deepEqual(f.completed, ['session']);
  f.event('run', 'delta');
  f.event('run', 'final');
  assert.equal(f.busy.get('session'), false, 'Late frames cannot revive a finished run');
  assert.equal(f.completed.length, 1);
});

test('older and unknown finals cannot stop newer or overlapping runs', async () => {
  const f = fixture();
  f.event('older');
  f.event('newer');
  f.event('unknown', 'final');
  f.event('older', 'final');
  await f.result('older', 'ok');
  assert.equal(f.busy.get('session'), true);
  assert.equal(f.tracker.runId('session'), 'newer');
  assert.equal(f.completed.length, 0);
  await f.result('newer', 'ok');
  assert.equal(f.busy.get('session'), false);
  assert.equal(f.completed.length, 1);
});

test('errors, aborts, local cancellation, and disconnect never produce completion notifications', async () => {
  for (const state of ['error', 'aborted']) {
    const f = fixture();
    f.event('run');
    f.event('run', state);
    await f.result('run', 'ok');
    assert.equal(f.completed.length, 0);
    assert.equal(f.busy.get('session'), false);
  }
  for (const cancel of ['cancel', 'clear']) {
    const f = fixture();
    f.event('run');
    await settle();
    if (cancel === 'cancel') f.tracker.cancel('session');
    else f.tracker.clear();
    await f.result('run', 'ok');
    assert.equal(f.completed.length, 0, 'Late wait results must be ignored');
    assert.equal(f.busy.get('session'), false);
  }
  const f = fixture();
  f.event('run');
  await f.result('run', 'error');
  assert.equal(f.completed.length, 0);
});

test('an early completion waits for send acknowledgment and stale send failures do not clear new runs', async () => {
  const f = fixture();
  const token = f.tracker.beginSend('session');
  f.event('run');
  await f.result('run', 'ok');
  assert.equal(f.busy.get('session'), true);
  assert.equal(f.completed.length, 0);
  f.tracker.acknowledge('session', token, 'run');
  assert.equal(f.completed.length, 1);
  const old = f.tracker.beginSend('session');
  f.tracker.cancel('session');
  f.event('new');
  f.tracker.failSend('session', old);
  f.tracker.acknowledge('session', old, 'old');
  assert.equal(f.tracker.runId('session'), 'new');
  assert.equal(f.busy.get('session'), true);
});

test('abort intent suppresses success before its RPC returns, even if a later lifecycle end follows', async () => {
  for (const local of [true, false]) {
    const f = fixture();
    f.event('run');
    if (local) f.tracker.abort('session', 'run');
    else f.event('run', 'aborted');
    f.tracker.event('session', 'agent', {
      runId: 'run',
      stream: 'lifecycle',
      data: { phase: 'end' },
    });
    await f.result('run', 'ok');
    assert.equal(f.completed.length, 0);
    assert.equal(f.busy.get('session'), false);
  }
});

test('unsupported wait falls back to a matching lifecycle end, never a chat-only success toast', async () => {
  for (const lifecycle of [false, true]) {
    const f = fixture();
    f.event('run');
    await settle();
    f.waits.get('run').reject(new Error('unknown method agent.wait'));
    await settle();
    if (lifecycle)
      f.tracker.event('session', 'agent', {
        runId: 'run',
        stream: 'lifecycle',
        data: { phase: 'end' },
      });
    else f.event('run', 'final');
    assert.equal(f.busy.get('session'), false);
    assert.equal(f.completed.length, lifecycle ? 1 : 0);
  }
});
