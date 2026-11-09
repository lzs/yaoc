const { test } = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const fs = require('node:fs');
const vm = require('node:vm');
const modules = {};
for (const file of ['models', 'sessionPins']) {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(`src/${file}.ts`, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      require: (name) => modules[name],
    }
  );
  modules['./' + file] = exports;
}
const { isSessionPinned, sessionPinPatch, sortPinnedSessions, changeSessionPin } =
  modules['./sessionPins'];
test('Gateway pin metadata handles boolean flags, timestamps and clear tombstones', () => {
  assert.equal(isSessionPinned({ pinnedAt: 1700000000000 }), true);
  assert.equal(isSessionPinned({ pinned: false, pinnedAt: 1700000000000 }), false);
  for (const pinnedAt of [0, -1, NaN, Infinity, '100'])
    assert.equal(isSessionPinned({ pinnedAt }), false);
  assert.equal(Object.keys(sessionPinPatch({ thinkingLevel: 'high' })).length, 0);
  assert.equal(sessionPinPatch({ pinnedAt: null }).pinned, false);
  assert.equal(sessionPinPatch({ entry: { pinnedAt: 100 } }).pinned, true);
  assert.equal(sessionPinPatch({ pinned: false, pinnedAt: 100 }).pinnedAt, undefined);
});
test('pin grouping preserves server ordering, row identities and the original array', () => {
  const rows = [{ key: 'a' }, { key: 'b', pinnedAt: 50 }, { key: 'c' }, { key: 'd', pinned: true }];
  assert.equal(Array.from(sortPinnedSessions(rows), (row) => row.key).join(','), 'b,d,a,c');
  assert.equal(rows.map((row) => row.key).join(','), 'a,b,c,d');
  assert.equal(sortPinnedSessions(rows)[0], rows[1]);
});
test('pin writes use the exact agent-scoped target and server-confirmed metadata', async () => {
  let sent;
  const pin = await changeSessionPin(
    async (method, params) => {
      sent = { method, params };
      return { ok: true, key: params.key, entry: { pinnedAt: 1700000000000 } };
    },
    { key: 'Project', agentId: 'research', sessionId: 'session-1' },
    true
  );
  assert.equal(sent.method, 'sessions.patch');
  assert.equal(sent.params.key, 'agent:research:project');
  assert.equal(sent.params.expectedSessionId, 'session-1');
  assert.equal(sent.params.pinned, true);
  assert.equal(pin.pinnedAt, 1700000000000);
  const unpin = await changeSessionPin(
    async () => ({ ok: true, entry: {} }),
    { key: 'project', agentId: 'research' },
    false
  );
  assert.equal(unpin.pinned, false);
  assert.equal(unpin.pinnedAt, undefined);
});
test('unsupported, denied, unconfirmed and mismatched pin writes are surfaced', async () => {
  const row = { key: 'project', agentId: 'main' };
  await assert.rejects(
    changeSessionPin(
      async () => {
        throw new Error('Invalid params: unexpected property pinned');
      },
      row,
      true
    ),
    /does not support session pins/
  );
  await assert.rejects(
    changeSessionPin(
      async () => ({ ok: false, error: { message: 'Permission denied' } }),
      row,
      true
    ),
    /Permission denied/
  );
  await assert.rejects(
    changeSessionPin(async () => ({ ok: true, entry: {} }), row, true),
    /did not confirm/
  );
  await assert.rejects(
    changeSessionPin(async () => ({ ok: true }), row, false),
    /did not confirm/
  );
  await assert.rejects(
    changeSessionPin(async () => ({ ok: true, key: 'other', entry: { pinned: true } }), row, true),
    /different session/
  );
});
