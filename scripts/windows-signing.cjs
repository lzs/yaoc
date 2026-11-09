// Authenticode uses the current user's certificate store; private keys stay in SimplySign.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
function signingConfig(env = process.env) {
  const thumbprint = (env.YAOC_AUTHENTICODE_THUMBPRINT || '').replace(/\s/g, '').toUpperCase();
  if (!thumbprint) return {};
  if (!/^[0-9A-F]{40}$/.test(thumbprint))
    throw new Error('YAOC_AUTHENTICODE_THUMBPRINT must be a 40-character certificate thumbprint.');
  return {
    certificateThumbprint: thumbprint,
    digestAlgorithm: 'sha256',
    timestampUrl: 'http://time.certum.pl',
    tsp: true,
  };
}
function signToolPath(env = process.env) {
  if (env.TAURI_WINDOWS_SIGNTOOL_PATH) return env.TAURI_WINDOWS_SIGNTOOL_PATH;
  const sdk = path.join(
    env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Windows Kits',
    '10',
    'bin'
  );
  if (fs.existsSync(sdk)) {
    const versions = fs.readdirSync(sdk).filter((name) => /^10\.0\.\d+\.\d+$/.test(name));
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const tool = path.join(
        sdk,
        version,
        process.arch === 'arm64' ? 'arm64' : 'x64',
        'signtool.exe'
      );
      if (fs.existsSync(tool)) return tool;
    }
  }
  throw new Error(
    'SignTool not found. Install Windows SDK Signing Tools or set TAURI_WINDOWS_SIGNTOOL_PATH.'
  );
}
function verifySignedFile(file, env = process.env) {
  if (!signingConfig(env).certificateThumbprint) return;
  // /tw turns a missing timestamp into a warning; any nonzero status fails packaging.
  const result = cp.spawnSync(signToolPath(env), ['verify', '/pa', '/all', '/tw', '/v', file], {
    stdio: 'inherit',
    windowsHide: true,
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error('Authenticode signature/timestamp verification failed: ' + file);
}
module.exports = { signingConfig, signToolPath, verifySignedFile };
