const { test } = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const exportsObject = {};
vm.runInNewContext(
  ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/models.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  { exports: exportsObject }
);
test('non-default agents stay scoped on older Gateways', async () => {
  let request;
  const result = await exportsObject.changeSessionModel(
    async (method, params) => {
      request = { method, params };
      return { ok: true };
    },
    'chat',
    'provider/model',
    'research'
  );
  assert.equal(request.params.key, 'agent:research:chat');
  assert.equal(result.modelProvider, 'provider');
  assert.equal(result.model, 'model');
});
test('model listing retries only schema compatibility errors', async () => {
  const calls = [];
  await exportsObject.loadSessionModels(
    async (...args) => {
      calls.push(args);
      if (calls.length === 1) throw new Error('Invalid params: unknown field');
      return { models: [] };
    },
    'main',
    'main'
  );
  assert.equal(calls.length, 2);
  let count = 0;
  await assert.rejects(
    exportsObject.loadSessionModels(
      async () => {
        count++;
        throw new Error('Unauthorized');
      },
      'main',
      'main'
    ),
    /Unauthorized/
  );
  assert.equal(count, 1);
});
test('invalid model lists and rejected changes are surfaced', async () => {
  assert.throws(() => exportsObject.normalizeModels({ models: null }), /invalid model list/);
  await assert.rejects(
    exportsObject.changeSessionModel(
      async () => ({ ok: false, error: { message: 'Denied' } }),
      'main',
      'provider/model'
    ),
    /Denied/
  );
});

test('Gateway thinking options preserve IDs, labels, order and explicit empty lists', () => {
  const result = exportsObject.normalizeThinkingMetadata({
    thinkingLevels: [
      { id: 'off', label: 'Disabled' },
      { id: 'adaptive', label: 'Automatic' },
      { id: 'low', label: 'Light' },
      { id: 'xhigh', label: 'Extra high' },
      { id: 'low', label: 'duplicate' },
      {},
    ],
    thinkingDefault: 'adaptive',
  });
  assert.deepEqual(
    Array.from(result.thinkingLevels, (option) => [option.id, option.label]),
    [
      ['off', 'Disabled'],
      ['adaptive', 'Automatic'],
      ['low', 'Light'],
      ['xhigh', 'Extra high'],
    ]
  );
  assert.equal(result.thinkingDefault, 'adaptive');
  assert.equal(exportsObject.reasoningOptions({ thinkingLevels: [] }, 'high').length, 0);
  const legacy = exportsObject.normalizeThinkingMetadata({
    thinkingOptions: ['off', 'low', 'high'],
  });
  assert.equal(legacy.thinkingLevels[0].label, 'None');
  assert.deepEqual(
    Array.from(legacy.thinkingLevels, (option) => option.id),
    ['off', 'low', 'high']
  );
  assert.equal(exportsObject.reasoningOptions({}, 'xhigh').at(-1).id, 'xhigh');
});

test('session metadata wins; defaults from a different model do not leak', () => {
  const defaults = {
    model: 'a',
    modelProvider: 'provider',
    thinkingLevels: [{ id: 'high', label: 'High' }],
    thinkingDefault: 'high',
  };
  const same = exportsObject.sessionThinkingMetadata(
    { model: 'a', modelProvider: 'provider' },
    defaults
  );
  assert.equal(same.thinkingLevels[0].id, 'high');
  const other = exportsObject.sessionThinkingMetadata(
    { model: 'b', modelProvider: 'provider' },
    defaults
  );
  assert.equal(other.thinkingLevels, undefined);
  const own = exportsObject.sessionThinkingMetadata(
    { model: 'a', modelProvider: 'provider', thinkingLevels: [] },
    defaults
  );
  assert.equal(own.thinkingLevels.length, 0);
});

test('model changes carry refreshed reasoning metadata and clear obsolete capabilities', async () => {
  const response = await exportsObject.changeSessionModel(
    async () => ({
      entry: { thinkingLevel: null },
      resolved: {
        model: 'b',
        modelProvider: 'provider',
        thinkingLevels: [{ id: 'adaptive', label: 'Adaptive' }],
        thinkingDefault: 'adaptive',
      },
    }),
    'main',
    'provider/b'
  );
  assert.equal(response.thinkingLevels[0].id, 'adaptive');
  assert.equal(response.thinkingDefault, 'adaptive');
  assert.equal(response.thinkingLevel, '');
  const old = await exportsObject.changeSessionModel(
    async () => ({ ok: true }),
    'main',
    'provider/a'
  );
  assert.equal(Object.hasOwn(old, 'thinkingLevels'), true);
  assert.equal(old.thinkingLevels, undefined);
  let params;
  const session = await exportsObject.loadSessionThinking(
    async (method, request) => {
      assert.equal(method, 'sessions.list');
      params = request;
      return {
        sessions: [
          { key: 'agent:research:chat', thinkingLevel: 'low', thinkingOptions: ['off', 'low'] },
        ],
      };
    },
    'research',
    'chat'
  );
  assert.equal(params.agentId, 'research');
  assert.equal(session.thinkingLevel, 'low');
  assert.equal(session.thinkingLevels[1].id, 'low');
});

test('explicit non-reasoning models do not receive a fabricated effort ladder', () => {
  const metadata = exportsObject.normalizeThinkingMetadata({ reasoning: false });
  assert.deepEqual(
    Array.from(metadata.thinkingLevels, (option) => option.id),
    ['off']
  );
  const advertised = exportsObject.normalizeThinkingMetadata({
    reasoning: false,
    thinkingLevels: [{ id: 'ultra', label: 'Ultra' }],
  });
  assert.equal(
    advertised.thinkingLevels[0].id,
    'ultra',
    'Advertised runtime choices remain authoritative'
  );
});

test('all agents use one canonical identity for short session names', () => {
  assert.equal(exportsObject.toGatewaySessionKey('main', 'test-2'), 'agent:main:test-2');
  assert.equal(exportsObject.toGatewaySessionKey('research', 'test-2'), 'agent:research:test-2');
  assert.equal(
    exportsObject.toGatewaySessionKey('main', 'agent:research:test-2'),
    'agent:research:test-2'
  );
  assert.equal(exportsObject.toGatewaySessionKey('main', 'main'), 'agent:main:main');
  assert.equal(exportsObject.toGatewaySessionKey('main', 'global'), 'global');
  assert.equal(exportsObject.sessionAgentId('agent:research:test-2', 'main'), 'research');
});

test('short and qualified session rows merge without losing labels or Gateway metadata', () => {
  for (const rows of [
    [
      { key: 'test-2', agentId: 'main', label: 'My test' },
      { key: 'agent:main:test-2', model: 'live-model' },
    ],
    [
      { key: 'agent:main:test-2', model: 'live-model' },
      { key: 'test-2', agentId: 'main', label: 'My test' },
    ],
  ]) {
    const sessions = exportsObject.normalizeSessions(rows, 'main');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].key, 'agent:main:test-2');
    assert.equal(sessions[0].label, 'My test');
    assert.equal(sessions[0].model, 'live-model');
  }
});

test('canonical model metadata requests still accept legacy short-key session responses', async () => {
  const result = await exportsObject.loadSessionThinking(
    async () => ({ sessions: [{ key: 'main', thinkingOptions: ['off', 'low'] }] }),
    'main',
    'agent:main:main'
  );
  assert.equal(result.thinkingLevels[1].id, 'low');
});
