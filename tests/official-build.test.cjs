const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOfficial } = require('../scripts/build-official.cjs');
const env = {
  USERPROFILE: 'C:\\Users\\test',
  LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
  Path: 'C:\\Windows\\System32',
  npm_execpath: __filename,
  YAOC_UPDATER_PUBLIC_KEY: 'public-key-fixture',
  TAURI_SIGNING_PRIVATE_KEY: 'private-key-path-fixture',
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
};
test('official packaging refuses missing signing configuration before running commands', () => {
  const incomplete = { ...env };
  delete incomplete.YAOC_UPDATER_PUBLIC_KEY;
  assert.throws(
    () =>
      buildOfficial({
        env: incomplete,
        platform: 'win32',
        run: () => assert.fail('Must not build'),
        log: () => {},
      }),
    /YAOC_UPDATER_PUBLIC_KEY/
  );
});
test('official packaging stops at the first failed task', () => {
  const calls = [];
  assert.throws(
    () =>
      buildOfficial({
        env,
        platform: 'win32',
        log: () => {},
        run: (_file, args) => {
          calls.push(args[2]);
          return { status: args[2] === 'release' ? 1 : 0 };
        },
      }),
    /release failed/
  );
  assert.deepEqual(calls, ['check', 'release']);
});
test('official packaging prepares build tools and runs the complete sequence without publishing', () => {
  const calls = [];
  buildOfficial({
    env,
    platform: 'win32',
    log: () => {},
    run: (_file, args, options) => {
      calls.push(args[2]);
      assert(options.env.Path.includes('.cargo'));
      assert(options.env.Path.includes('llvm-mingw'));
      assert.equal(options.env.TAURI_SIGNING_PRIVATE_KEY, env.TAURI_SIGNING_PRIVATE_KEY);
      return { status: 0 };
    },
  });
  assert.deepEqual(calls, ['check', 'release', 'notices', 'package:installers']);
});
