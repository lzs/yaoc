const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Reuse the real App hook/IPC harness without executing its scenario runner.
function fixture() {
  const prefix = fs.readFileSync('tests/session-state.test.cjs', 'utf8').split('(async () => {')[0];
  const filename = path.resolve('tests/async-scope-fixture.cjs');
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = module.paths;
  instance._compile(
    prefix +
      `
    module.exports = { render, settle, api, get view() { return view; },
      initStatus() { effects.find(effect => effect.toString().includes('api.onStatus'))(); },
      status(value) { statusListener(value); }
    };
  `,
    filename
  );
  const app = instance.exports;
  app.render();
  app.view.setConnStatus({ state: 'connected' });
  app.render();
  return app;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('reset completion preserves the newly selected session on both success and failure', async () => {
  for (const failed of [false, true]) {
    const app = fixture();
    const reset = deferred();
    app.api.request = (method) => {
      if (method === 'sessions.reset') return reset.promise;
      if (method === 'chat.history')
        return Promise.resolve({ messages: [{ role: 'assistant', content: 'B history' }] });
      return Promise.resolve({
        sessions: [
          { key: 'main', agentId: 'main' },
          { key: 'b', agentId: 'main' },
        ],
      });
    };
    const pending = app.view.performResetSession();
    app.view.handleSelectSession('b');
    app.render();
    await app.settle();
    app.render();
    if (failed) reset.reject(new Error('Denied'));
    else reset.resolve({ ok: true });
    await pending;
    app.render();
    assert.equal(app.view.selectedSessionKey, 'agent:main:b');
    assert.deepEqual(
      Array.from(app.view.messages, (m) => m.content),
      ['B history']
    );
  }
});

test('session listings cannot overwrite a different agent or a newer listing', async () => {
  const app = fixture();
  const old = deferred(),
    latest = deferred();
  let count = 0;
  app.api.request = () => (++count === 1 ? old.promise : latest.promise);
  const first = app.view.fetchSessionsAndSyncSelection('main', 'main');
  const second = app.view.fetchSessionsAndSyncSelection('main', 'main');
  latest.resolve({ sessions: [{ key: 'new', agentId: 'main' }] });
  await second;
  app.render();
  old.resolve({ sessions: [{ key: 'old', agentId: 'main' }] });
  assert.equal(await first, null);
  app.render();
  assert.equal(app.view.selectedSessionKey, 'agent:main:new');
  const other = deferred();
  app.api.request = () => other.promise;
  const pending = app.view.fetchSessionsAndSyncSelection('main', 'new');
  app.view.setSelectedAgentId('other');
  app.view.setSessions([{ key: 'agent:other:b', agentId: 'other' }]);
  app.render();
  other.resolve({ sessions: [{ key: 'main', agentId: 'main' }] });
  assert.equal(await pending, null);
  app.render();
  assert.equal(app.view.selectedAgentId, 'other');
  assert.equal(app.view.sessions[0].key, 'agent:other:b');
});

test('failed session listing does not retry on another profile', async () => {
  const app = fixture(),
    listing = deferred();
  let calls = 0;
  app.api.request = () => {
    calls++;
    return listing.promise;
  };
  const pending = app.view.fetchSessionsAndSyncSelection('main', 'main');
  app.view.setActiveProfileId('other');
  app.render();
  listing.reject(new Error('Disconnected'));
  assert.equal(await pending, null);
  assert.equal(calls, 1);
});

test('save completion cannot replace another file saved baseline', async () => {
  const app = fixture(),
    save = deferred();
  app.api.request = (method) =>
    method === 'agents.files.set'
      ? save.promise
      : Promise.resolve({ file: { content: 'B original' } });
  app.view.setActiveFileName('A.md');
  app.view.setFileContent('A edited');
  app.render();
  const pending = app.view.handleSaveWorkspaceFile();
  await app.view.loadWorkspaceFile('main', 'B.md');
  app.render();
  save.resolve({ ok: true });
  await pending;
  app.render();
  assert.equal(app.view.activeFileName, 'B.md');
  assert.equal(app.view.fileContent, 'B original');
  assert.equal(app.view.savedFileContent, 'B original');
  assert.ok(!app.view.fileStatusMsg.includes('Saved A.md'));
});

test('save retries stop after profile changes or reconnecting the same profile', async () => {
  for (const reconnect of [false, true]) {
    const app = fixture(),
      save = deferred();
    app.initStatus();
    const methods = [];
    app.api.request = (method) => {
      methods.push(method);
      if (method === 'agents.workspace.get')
        return Promise.resolve({ file: { content: 'A', hash: 'a'.repeat(64) } });
      return method === 'agents.files.set' ? save.promise : Promise.resolve({});
    };
    // A known Gateway hash lets the save go out at once, before the profile changes.
    await app.view.loadWorkspaceFile('main', 'A.md');
    methods.length = 0;
    app.render();
    app.view.setFileContent('Private A content');
    app.render();
    const pending = app.view.handleSaveWorkspaceFile();
    if (reconnect) app.status({ state: 'connected' });
    else app.view.setActiveProfileId('other');
    app.render();
    save.reject(new Error('Disconnected'));
    await pending;
    assert.deepEqual(methods, ['agents.files.set']);
  }
});

test('same-scope compatibility fallback still saves and preserves newer edits as dirty', async () => {
  const app = fixture(),
    save = deferred();
  let fallback;
  app.api.request = (method, params) => {
    if (method === 'agents.files.set') return Promise.reject(new Error('Unsupported schema'));
    if (method === 'sessions.files.set') {
      fallback = params;
      return save.promise;
    }
    return Promise.resolve({});
  };
  app.view.setActiveFileName('A.md');
  app.view.setFileContent('Original save');
  app.render();
  const pending = app.view.handleSaveWorkspaceFile();
  for (let attempt = 0; !fallback && attempt < 100; attempt++) await new Promise(setImmediate);
  assert.equal(fallback.content, 'Original save');
  assert.equal(
    fallback.expectedHash,
    require('node:crypto').createHash('sha256').update('').digest('hex')
  );
  app.view.setFileContent('Newer edits');
  app.render();
  save.resolve({ ok: true });
  await pending;
  app.render();
  assert.equal(app.view.savedFileContent, 'Original save');
  assert.equal(app.view.fileContent, 'Newer edits');
});

test('workspace load fallbacks stop after changing Gateway profiles', async () => {
  const app = fixture(),
    load = deferred();
  const methods = [];
  app.api.request = (method) => {
    methods.push(method);
    return load.promise;
  };
  const pending = app.view.loadWorkspaceFile('main', 'A.md');
  app.view.setActiveProfileId('other');
  app.render();
  load.reject(new Error('Disconnected'));
  await pending;
  assert.deepEqual(methods, ['agents.workspace.get']);
  app.render();
  assert.equal(app.view.loadingFile, false, 'Cancelling a stale load must leave the editor usable');
});

test('session file saves use the original bytes hash and refresh it after repeated saves', async () => {
  const app = fixture();
  const hash = (text) => require('node:crypto').createHash('sha256').update(text).digest('hex');
  let remote = 'Original\r\nUnicode: 例子\n';
  const expectedHashes = [];
  app.api.request = async (method, params) => {
    if (method === 'agents.workspace.get') return { file: { content: remote } };
    if (method === 'agents.files.set') throw new Error('unsupported file "test_sendbox.txt"');
    if (method === 'sessions.files.set') {
      assert.match(params.expectedHash, /^[a-f0-9]{64}$/);
      expectedHashes.push(params.expectedHash);
      assert.equal(params.expectedHash, hash(remote));
      remote = params.content;
      return { file: { hash: hash(remote) } };
    }
    return {};
  };
  await app.view.loadWorkspaceFile('main', 'test_sendbox.txt');
  app.render();
  app.view.setFileContent('First edit');
  app.render();
  await app.view.handleSaveWorkspaceFile();
  app.render();
  assert.equal(remote, 'First edit');
  assert.equal(app.view.savedFileContent, 'First edit');
  assert.equal(app.view.savedFileHash, hash('First edit'));
  app.view.setFileContent('Second edit');
  app.render();
  await app.view.handleSaveWorkspaceFile();
  assert.deepEqual(expectedHashes, [hash('Original\r\nUnicode: 例子\n'), hash('First edit')]);
  assert.equal(remote, 'Second edit');
});

test('Gateway-provided byte hashes are retained and save conflicts preserve drafts', async () => {
  const app = fixture();
  const originalHash = 'b'.repeat(64); // The wire text may omit a UTF-8 BOM that exists on disk.
  let writes = 0;
  app.api.request = async (method, params) => {
    if (method === 'agents.workspace.get')
      return { file: { content: 'Original', hash: originalHash } };
    if (method === 'agents.files.set') throw new Error('unsupported file');
    if (method === 'sessions.files.set') {
      writes++;
      assert.equal(params.expectedHash, originalHash);
      throw new Error('session file changed since it was read');
    }
    return {};
  };
  await app.view.loadWorkspaceFile('main', 'nested/test.txt');
  app.render();
  app.view.setFileContent('Unsaved draft');
  app.render();
  await app.view.handleSaveWorkspaceFile();
  app.render();
  assert.equal(writes, 1);
  assert.equal(app.view.fileContent, 'Unsaved draft');
  assert.equal(app.view.savedFileContent, 'Original');
  assert.match(app.view.fileStatusMsg, /File changed on the Gateway/);
});

test('agent file saves are bound to the read revision and conflicts never fall back', async () => {
  const app = fixture();
  const calls = [];
  app.api.request = async (method, params) => {
    calls.push([method, params]);
    if (method === 'agents.workspace.get')
      return { file: { content: 'Remote', hash: 'd'.repeat(64) } };
    if (method === 'agents.files.set')
      throw new Error('agent file "MEMORY.md" changed since it was read');
    return {};
  };
  await app.view.loadWorkspaceFile('main', 'MEMORY.md');
  app.render();
  app.view.setFileContent('My draft');
  app.render();
  await app.view.handleSaveWorkspaceFile();
  app.render();
  const writes = calls.filter(([method]) => method.endsWith('.set'));
  assert.deepEqual(
    writes.map(([method, params]) => [method, params.expectedHash, params.expectedMissing]),
    [['agents.files.set', 'd'.repeat(64), undefined]]
  );
  assert.equal(app.view.fileContent, 'My draft');
  assert.equal(app.view.savedFileContent, 'Remote');
  assert.match(app.view.fileStatusMsg, /File changed on the Gateway/);
});

test('a missing agent file is created only if it is still missing', async () => {
  const app = fixture();
  const sets = [];
  app.api.request = async (method, params) => {
    if (method === 'agents.workspace.get') throw new Error('not found');
    if (method === 'agents.files.get') return { file: { name: 'DREAMS.md', missing: true } };
    if (method === 'agents.files.set') {
      sets.push(params);
      return { ok: true, file: { hash: 'e'.repeat(64) } };
    }
    return {};
  };
  await app.view.loadWorkspaceFile('main', 'DREAMS.md');
  app.render();
  assert.match(app.view.fileStatusMsg, /does not exist yet; Save creates it/);
  app.view.setFileContent('# Dreams');
  app.render();
  await app.view.handleSaveWorkspaceFile();
  app.render();
  app.view.setFileContent('# Dreams\n\nMore');
  app.render();
  await app.view.handleSaveWorkspaceFile();
  assert.deepEqual(
    sets.map((p) => [p.expectedMissing, p.expectedHash]),
    [
      [true, undefined],
      [undefined, 'e'.repeat(64)],
    ]
  );
});

test('pin writes confirm once and preserve another selected session', async () => {
  const app = fixture();
  const write = deferred();
  const rows = [
    { key: 'agent:main:main', agentId: 'main', sessionId: 'a' },
    { key: 'agent:main:b', agentId: 'main', sessionId: 'b' },
  ];
  app.view.setSessions(rows);
  app.render();
  let writes = 0;
  app.api.request = (method) => {
    if (method === 'sessions.patch') {
      writes++;
      return write.promise;
    }
    if (method === 'chat.history') return Promise.resolve({ messages: [] });
    return Promise.resolve({ sessions: rows });
  };
  const pending = app.view.handleToggleSessionPin(rows[0]);
  await app.view.handleToggleSessionPin(rows[0]);
  app.render();
  assert.equal(writes, 1);
  assert.equal(app.view.sessions[0].pinned, undefined);
  app.view.handleSelectSession('b');
  app.render();
  rows[0] = { ...rows[0], pinnedAt: 100 };
  write.resolve({ ok: true, entry: { pinnedAt: 100 } });
  await pending;
  app.render();
  assert.equal(app.view.selectedSessionKey, 'agent:main:b');
  assert.equal(app.view.sessions[0].pinnedAt, 100);
  assert.equal(app.view.sessionPinError, '');
});

test('pin completions cannot affect a switched profile, agent or connection', async () => {
  for (const change of ['profile', 'agent', 'connection']) {
    for (const failed of [false, true]) {
      const app = fixture();
      app.initStatus();
      const write = deferred();
      const row = { key: 'agent:main:main', agentId: 'main' };
      app.view.setSessions([row]);
      app.render();
      app.api.request = () => write.promise;
      const pending = app.view.handleToggleSessionPin(row);
      if (change === 'profile') app.view.setActiveProfileId('other');
      else if (change === 'agent') app.view.setSelectedAgentId('other');
      else app.status({ state: 'disconnected' });
      app.render();
      if (failed) write.reject(new Error('Old connection denied the pin'));
      else write.resolve({ ok: true, entry: { pinnedAt: 100 } });
      await pending;
      app.render();
      assert.equal(app.view.sessions[0].pinnedAt, undefined);
      assert.equal(app.view.sessionPinError, '');
    }
  }
});

test('a session list sampled before a pin cannot overwrite the acknowledged pin', async () => {
  const app = fixture();
  const oldList = deferred();
  const row = { key: 'agent:main:main', agentId: 'main' };
  app.view.setSessions([row]);
  app.render();
  let lists = 0;
  app.api.request = (method) => {
    if (method === 'sessions.patch') return Promise.resolve({ ok: true, entry: { pinnedAt: 100 } });
    return ++lists === 1
      ? oldList.promise
      : Promise.resolve({ sessions: [{ ...row, pinnedAt: 100 }] });
  };
  const refresh = app.view.fetchSessionsAndSyncSelection('main', 'main');
  await app.view.handleToggleSessionPin(row);
  app.render();
  oldList.resolve({ sessions: [row] });
  await refresh;
  app.render();
  assert.equal(app.view.sessions[0].pinnedAt, 100);
});
