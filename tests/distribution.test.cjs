const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generate } = require('../scripts/installer-update-metadata.cjs');
test('installer update metadata uses one signed combined installer for both architectures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaoc-metadata-'));
  try {
    assert.throws(() => generate(dir, '2027.1.0-dev123'), /official/);
    fs.writeFileSync(path.join(dir, 'yaoc-setup.exe'), 'test installer');
    assert.throws(() => generate(dir, '2027.1.0'));
    fs.writeFileSync(
      path.join(dir, 'yaoc-setup.exe.sig'),
      Buffer.from('signature fixture').toString('base64')
    );
    const metadata = generate(dir, '2027.1.0');
    assert.equal(
      metadata.platforms['windows-aarch64'].url,
      'https://github.com/lzs/yaoc/releases/download/v2027.1.0/yaoc-setup.exe'
    );
    assert.equal(Object.keys(metadata.platforms).length, 2);
    assert.deepEqual(metadata.platforms['windows-x86_64'], metadata.platforms['windows-aarch64']);
    fs.writeFileSync(path.join(dir, 'yaoc-setup.exe.sig'), '');
    assert.throws(() => generate(dir, '2027.1.0'), /signature/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('uninstaller cannot remove shared data or kill portable copies by name', () => {
  const template = fs.readFileSync('src-tauri/windows/installer.nsi', 'utf8');
  assert.doesNotMatch(
    template,
    /DeleteAppDataCheckbox|RmDir \/r|DELETEAPPDATA|CheckIfAppIsRunning/
  );
  assert.match(template, /Delete "\$INSTDIR\\install-metadata.json"/);
  assert.match(template, /Call un.YAOCCheckInstalledExecutable/);
  assert.match(template, /!insertmacro SetLnkAppUserModelId/);
});

test('installer packaging passes the runtime public key to Tauri without exposing private signing material', () => {
  const { installerConfig } = require('../scripts/installer-config.cjs');
  const config = installerConfig({
    YAOC_UPDATER_PUBLIC_KEY: ' public-key-fixture\r\n',
    TAURI_SIGNING_PRIVATE_KEY: 'private-key-fixture',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'password-fixture',
  });
  assert.equal(config.plugins.updater.pubkey, 'public-key-fixture');
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert(!JSON.stringify(config).includes('private-key-fixture'));
  assert(!JSON.stringify(config).includes('password-fixture'));
  assert.equal(installerConfig({}).bundle.createUpdaterArtifacts, false);
});

test('Authenticode config is optional, validates certificate selection, and uses RFC3161 SHA256 timestamps', () => {
  const { installerConfig } = require('../scripts/installer-config.cjs');
  assert.deepEqual(installerConfig({}).bundle.windows, {});
  const thumbprint = 'a'.repeat(40);
  const config = installerConfig({ YAOC_AUTHENTICODE_THUMBPRINT: ' ' + thumbprint + ' ' });
  assert.deepEqual(config.bundle.windows, {
    certificateThumbprint: thumbprint.toUpperCase(),
    digestAlgorithm: 'sha256',
    timestampUrl: 'http://time.certum.pl',
    tsp: true,
  });
  assert.throws(() => installerConfig({ YAOC_AUTHENTICODE_THUMBPRINT: 'invalid' }), /thumbprint/);
});
