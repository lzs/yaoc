// Bundle the already-built executable; never rebuild between portable and installer packaging.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { installerConfig } = require('./installer-config.cjs');
const root = path.resolve(__dirname, '..');
const { version } = require('../package.json');
const official = /^\d+\.\d+\.\d+$/.test(version);
function run(args, arm64Payload = '') {
  const result = cp.spawnSync(
    process.execPath,
    [require.resolve('@tauri-apps/cli/tauri.js'), ...args],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        YAOC_ARM64_PAYLOAD: arm64Payload,
        YAOC_NODE_EXECUTABLE: process.execPath,
        YAOC_CAPTURE_SCRIPT: path.join(__dirname, 'capture-installer-payload.cjs'),
      },
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Tauri bundling failed');
}
const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
try {
  if (official && (!process.env.YAOC_UPDATER_PUBLIC_KEY || !process.env.TAURI_SIGNING_PRIVATE_KEY))
    throw new Error(
      'Official distribution requires YAOC_UPDATER_PUBLIC_KEY and TAURI_SIGNING_PRIVATE_KEY. See docs/UPDATES.md.'
    );
  fs.mkdirSync(path.join(root, 'release'), { recursive: true });
  // Capture ARM64 first, then include it in the final x64-hosted installer.
  let arm64Payload = '';
  for (const [arch, triple] of [
    ['arm64', 'aarch64-pc-windows-gnullvm'],
    ['x64', 'x86_64-pc-windows-gnullvm'],
  ]) {
    const exe = path.join(root, 'src-tauri/target', triple, 'release/yaoc.exe');
    const statePath = exe + '.bundle-state.json';
    const pristine = exe + '.pre-bundle.exe';
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state.version === version && hash(exe) === state.outputHash) {
        if (hash(pristine) !== state.inputHash)
          throw new Error('Pristine build changed; rebuild before packaging');
        fs.copyFileSync(pristine, exe);
      }
    }
    if (!fs.readFileSync(exe).includes(Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK')))
      throw new Error('Expected a pristine cargo executable; rebuild before packaging');
    fs.copyFileSync(exe, pristine);
    const inputHash = hash(exe);
    fs.rmSync(exe + '.nsis-payload.exe', { force: true });
    // Tauri signs after patching; capture those exact signed payload bytes.
    const config = installerConfig();
    // Only the final combined installer is an updater artifact.
    if (arch === 'arm64') config.bundle.createUpdaterArtifacts = false;
    run(
      [
        'bundle',
        '--target',
        triple,
        '--bundles',
        'nsis',
        '--ci',
        '--config',
        JSON.stringify(config),
      ],
      arm64Payload
    );
    const directory = path.join(root, 'src-tauri/target', triple, 'release/bundle/nsis');
    const source = path.join(directory, 'YAOC_' + version + '_' + arch + '-setup.exe');
    if (!fs.existsSync(source)) throw new Error('Missing NSIS installer for ' + arch);
    require('./windows-signing.cjs').verifySignedFile(source);
    if (arch === 'x64') {
      const destination = path.join(root, 'release', 'yaoc-setup.exe');
      fs.copyFileSync(source, destination);
      if (fs.existsSync(source + '.sig')) fs.copyFileSync(source + '.sig', destination + '.sig');
      else fs.rmSync(destination + '.sig', { force: true });
    }
    if (!fs.existsSync(exe + '.nsis-payload.exe'))
      throw new Error('NSIS did not capture its application payload');
    if (arch === 'arm64') arm64Payload = exe + '.nsis-payload.exe';
    fs.copyFileSync(exe + '.nsis-payload.exe', exe);
    fs.writeFileSync(statePath, JSON.stringify({ version, inputHash, outputHash: hash(exe) }));
    console.log('Packaged ' + arch + ' installer; application SHA-256 ' + hash(exe));
  }
  // Retire separate downloads outside the active release set.
  for (const arch of ['x64', 'arm64']) {
    for (const suffix of ['.exe', '.exe.sig']) {
      const name = 'yaoc-' + arch + '-setup' + suffix;
      const previous = path.join(root, 'release', name);
      if (fs.existsSync(previous)) {
        const retired = path.join(root, 'release/archive', 'retired-installers-' + Date.now());
        fs.mkdirSync(retired, { recursive: true });
        fs.renameSync(previous, path.join(retired, name));
      }
    }
  }
  // Copy the exact application payloads embedded by the combined installer.
  const packaged = cp.spawnSync(process.execPath, [path.join(__dirname, 'package-portable.cjs')], {
    stdio: 'inherit',
    cwd: root,
  });
  if (packaged.status !== 0) throw new Error('Portable packaging failed');
  if (official) require('./installer-update-metadata.cjs').generate();
  else fs.rmSync(path.join(root, 'release', 'installer-update.json'), { force: true });
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
