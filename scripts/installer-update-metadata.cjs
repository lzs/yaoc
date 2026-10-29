// Tauri-compatible official metadata; portable clients only use its version.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function generate(
  directory = path.join(root, 'release'),
  version = require('../package.json').version
) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error('Only official versions may be published as updates');
  const platforms = {};
  for (const [arch, target] of [
    ['x64', 'windows-x86_64'],
    ['arm64', 'windows-aarch64'],
  ]) {
    const name = 'yaoc-' + arch + '-setup.exe';
    if (!fs.statSync(path.join(directory, name)).isFile())
      throw new Error('Missing installer ' + name);
    const signature = fs.readFileSync(path.join(directory, name + '.sig'), 'utf8').trim();
    if (!signature || !/^[A-Za-z0-9+/=]+$/.test(signature))
      throw new Error('Missing or invalid Tauri signature for ' + name);
    platforms[target] = {
      signature,
      url: 'https://github.com/lzs/yaoc/releases/download/v' + version + '/' + name,
    };
  }
  const metadata = { version, pub_date: new Date().toISOString(), platforms };
  fs.writeFileSync(
    path.join(directory, 'installer-update.json'),
    JSON.stringify(metadata, null, 2) + '\n'
  );
  return metadata;
}
module.exports = { generate };
if (require.main === module) {
  try {
    generate();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
