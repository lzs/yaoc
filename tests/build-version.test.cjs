const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBuildInfo, syncVersion } = require('../scripts/sync-version.cjs');

test('normal builds preserve zero-padded dates and official builds remove the suffix', () => {
  const january = new Date(2026, 0, 27, 20, 5);
  const normal = createBuildInfo('2026.1.0', false, january);
  assert.equal(normal.version, '2026.1.0-dev01272005');
  assert.equal(normal.channel, 'beta');
  assert.equal(normal.timestamp, '2026-01-27 20:05');
  const next = createBuildInfo(normal.version, false, new Date(2026, 9, 27, 20, 5));
  assert.equal(next.version, '2026.1.0-dev10272005');
  assert.equal(createBuildInfo(next.version, true, january).version, '2026.1.0');
  assert.equal(createBuildInfo(next.version, true, january).channel, 'official');
  assert.equal(createBuildInfo('2027.2.3', false, january).version, '2027.2.3-dev01272005');
});

test('all manifests and lockfiles agree across repeated builds and an official release', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yaoc-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src-tauri'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ version: '2026.1.0', name: 'yaoc' })
  );
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({
      version: '2026.1.0',
      packages: { '': { version: '2026.1.0' }, dependency: { version: '1.2.3' } },
    })
  );
  fs.writeFileSync(
    path.join(root, 'src-tauri/tauri.conf.json'),
    JSON.stringify({ version: '2026.1.0', productName: 'YAOC' })
  );
  fs.writeFileSync(
    path.join(root, 'src-tauri/Cargo.toml'),
    '[package]\nname = "yaoc"\nversion = "2026.1.0"\n'
  );
  fs.writeFileSync(
    path.join(root, 'src-tauri/Cargo.lock'),
    '[[package]]\nname = "other"\nversion = "1.2.3"\n\n[[package]]\nname = "yaoc"\nversion = "2026.1.0"\n'
  );
  for (const version of ['2026.1.0-dev01272005', '2026.1.0-dev10272006', '2026.1.0']) {
    syncVersion(root, version);
    const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(JSON.parse(read('package.json')).version, version);
    const lock = JSON.parse(read('package-lock.json'));
    assert.equal(lock.version, version);
    assert.equal(lock.packages[''].version, version);
    assert.equal(lock.packages.dependency.version, '1.2.3');
    assert.equal(JSON.parse(read('src-tauri/tauri.conf.json')).version, version);
    assert(read('src-tauri/Cargo.toml').includes(`version = "${version}"`));
    assert(read('src-tauri/Cargo.lock').includes(`name = "yaoc"\nversion = "${version}"`));
    assert(read('src-tauri/Cargo.lock').includes('name = "other"\nversion = "1.2.3"'));
  }
});
