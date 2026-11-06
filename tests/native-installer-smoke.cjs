// Explicit Windows acceptance test. Installer identity is isolated from the real YAOC installation.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { version } = require('../package.json');
const id = 'io.github.lzs.yaoc.integration-test';
const name = 'YAOC Integration Test';
const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function run(file, args) {
  const result = cp.spawnSync(file, args, {
    cwd: root,
    windowsHide: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      YAOC_ARM64_PAYLOAD: path.join(
        root,
        'src-tauri/target/aarch64-pc-windows-gnullvm/release/yaoc.exe.nsis-payload.exe'
      ),
      YAOC_NODE_EXECUTABLE: process.execPath,
      YAOC_CAPTURE_SCRIPT: path.join(root, 'scripts/capture-installer-payload.cjs'),
    },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, file + ' failed');
}
(async () => {
  const testRoot = fs.mkdtempSync(path.join(root, '.local', 'nsis-test-'));
  const install = path.join(testRoot, 'installed');
  const data = [path.join(process.env.APPDATA, id), path.join(process.env.LOCALAPPDATA, id)];
  for (const directory of data) {
    assert(
      !fs.existsSync(directory),
      'Refusing to use an existing integration-test data directory'
    );
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'retain.txt'), 'shared data sentinel');
  }
  const runtimeExe = path.join(root, 'src-tauri/target/x86_64-pc-windows-gnullvm/release/yaoc.exe');
  const nativeTriple =
    process.arch === 'arm64' ? 'aarch64-pc-windows-gnullvm' : 'x86_64-pc-windows-gnullvm';
  const preservedPayload = fs.readFileSync(runtimeExe);
  try {
    for (const forceArm64 of [false, true]) {
      fs.copyFileSync(runtimeExe + '.pre-bundle.exe', runtimeExe);
      const template = path.join(testRoot, 'installer.nsi');
      const sourceTemplate = fs.readFileSync(
        path.join(root, 'src-tauri/windows/installer.nsi'),
        'utf8'
      );
      // This override exists only in the isolated test template, never in a release.
      fs.writeFileSync(
        template,
        forceArm64
          ? sourceTemplate.replace('${If} ${IsNativeARM64}', '${If} 1 = 1')
          : sourceTemplate
      );
      const config = {
        productName: name,
        identifier: id,
        bundle: { createUpdaterArtifacts: false, windows: { nsis: { template } } },
      };
      run(process.execPath, [
        require.resolve('@tauri-apps/cli/tauri.js'),
        'bundle',
        '--target',
        'x86_64-pc-windows-gnullvm',
        '--bundles',
        'nsis',
        '--ci',
        '--no-sign',
        '--config',
        JSON.stringify(config),
      ]);
      const installer = path.join(
        root,
        'src-tauri/target/x86_64-pc-windows-gnullvm/release/bundle/nsis',
        name + '_' + version + '_x64-setup.exe'
      );
      run(installer, ['/S', '/NS', '/D=' + install]);
      assert(fs.existsSync(path.join(install, 'yaoc.exe')));
      assert.equal(
        hash(path.join(install, 'yaoc.exe')),
        hash(
          path.join(
            root,
            'src-tauri/target/' +
              (forceArm64 ? 'aarch64-pc-windows-gnullvm' : nativeTriple) +
              '/release/yaoc.exe.nsis-payload.exe'
          )
        ),
        'Installer payload differs from portable'
      );
      const raw = fs.readFileSync(path.join(install, 'install-metadata.json'));
      const metadata = JSON.parse(raw.subarray(2).toString('utf16le'));
      assert.equal(metadata.formatVersion, 1);
      assert.equal(metadata.installDirectory, install);
      fs.writeFileSync(path.join(install, 'unrelated.txt'), 'do not delete');
      // Upgrade-in-place preserves all shared data and unrelated installation files.
      run(installer, ['/S', '/NS', '/UPDATE', '/D=' + install]);
      for (const directory of data)
        assert.equal(
          fs.readFileSync(path.join(directory, 'retain.txt'), 'utf8'),
          'shared data sentinel'
        );
      run(path.join(install, 'uninstall.exe'), ['/S']);
      for (let i = 0; i < 200 && fs.existsSync(path.join(install, 'yaoc.exe')); i++)
        await sleep(100);
      assert(!fs.existsSync(path.join(install, 'yaoc.exe')), 'Uninstall failed');
      assert(!fs.existsSync(path.join(install, 'install-metadata.json')));
      assert.equal(fs.readFileSync(path.join(install, 'unrelated.txt'), 'utf8'), 'do not delete');
      for (const directory of data)
        assert.equal(
          fs.readFileSync(path.join(directory, 'retain.txt'), 'utf8'),
          'shared data sentinel'
        );
      console.log(
        'PASS: ' +
          (forceArm64 ? 'forced ARM64 payload extraction' : 'native architecture selection') +
          ', identical portable/installer payload, metadata, upgrade, silent uninstall, preserved shared data and unrelated files.'
      );
    }
  } finally {
    fs.writeFileSync(runtimeExe, preservedPayload);
    if (
      fs.existsSync(path.join(install, 'yaoc.exe')) &&
      fs.existsSync(path.join(install, 'uninstall.exe'))
    ) {
      run(path.join(install, 'uninstall.exe'), ['/S']);
      for (let i = 0; i < 200 && fs.existsSync(path.join(install, 'yaoc.exe')); i++)
        await sleep(100);
    }
    // Remove only this test's exact sentinels; never recursively delete AppData.
    for (const directory of data) {
      fs.unlinkSync(path.join(directory, 'retain.txt'));
      fs.rmdirSync(directory);
    }
    console.log('Isolated installer test directory: ' + testRoot);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
