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
