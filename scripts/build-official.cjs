// Explicit official build entry point. Signing values must be loaded in the parent shell.
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { createBuildInfo } = require('./sync-version.cjs');
const root = path.resolve(__dirname, '..');

function buildOfficial({
  env = process.env,
  platform = process.platform,
  run = spawnSync,
  log = console.log,
} = {}) {
  if (platform !== 'win32') throw new Error('Official YAOC packaging must run on Windows.');
  for (const name of ['YAOC_UPDATER_PUBLIC_KEY', 'TAURI_SIGNING_PRIVATE_KEY']) {
    if (!env[name]?.trim())
      throw new Error(`Set ${name} before running release:package. See docs/UPDATES.md.`);
  }
  if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined)
    throw new Error(
      'Set TAURI_SIGNING_PRIVATE_KEY_PASSWORD before running release:package (use an empty value only for a passwordless key).'
    );
  if (!env.USERPROFILE || !env.LOCALAPPDATA)
    throw new Error('USERPROFILE and LOCALAPPDATA are required to locate the Windows build tools.');
  if (!env.npm_execpath || !fs.existsSync(env.npm_execpath))
    throw new Error('Run this script with npm.cmd run release:package.');

  const childEnv = { ...env };
  const pathKey = Object.keys(childEnv).find((key) => key.toLowerCase() === 'path') || 'Path';
  childEnv[pathKey] = [
    path.join(env.USERPROFILE, '.cargo', 'bin'),
    path.join(env.LOCALAPPDATA, 'Programs', 'llvm-mingw', 'bin'),
    childEnv[pathKey] || '',
  ].join(path.win32.delimiter);
  const version = createBuildInfo(require('../package.json').version, true).version;
  log(`Building and packaging official YAOC ${version} for x64 and ARM64.`);
  for (const task of ['check', 'release', 'notices', 'package:installers']) {
    log(`Running ${task}...`);
    const result = run(process.execPath, [env.npm_execpath, 'run', task], {
      cwd: root,
      env: childEnv,
      stdio: 'inherit',
    });
    if (result.error) throw new Error(`Could not start ${task}: ${result.error.message}`);
    if (result.status !== 0)
      throw new Error(
        `${task} failed${result.signal ? ` (${result.signal})` : ` (exit ${result.status})`}; later steps were not run.`
      );
  }
  log(`Official YAOC ${version} is packaged in release/. Nothing has been tagged or published.`);
}
module.exports = { buildOfficial };
if (require.main === module) {
  try {
    buildOfficial();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
