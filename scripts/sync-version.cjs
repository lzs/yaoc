const fs = require('node:fs');
const path = require('node:path');

function createBuildInfo(packageVersion, official = false, date = new Date()) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      packageVersion
    );
  if (!match) throw new Error('Package version must use major.minor.patch');
  const baseVersion = `${match[1]}.${match[2]}.${match[3]}`;
  const pad = (value) => String(value).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  return {
    version: official ? baseVersion : `${baseVersion}-dev${month}${day}${hour}${minute}`,
    channel: official ? 'official' : 'beta',
    timestamp: `${year}-${month}-${day} ${hour}:${minute}`,
  };
}

// Keep the compiled Cargo/Tauri version, frontend label, and npm metadata identical.
function syncVersion(root, version) {
  const updates = [];
  for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) {
    const target = path.join(root, file);
    const text = fs.readFileSync(target, 'utf8');
    JSON.parse(text);
    let updated = text.replace(
      /("version"\s*:\s*")[^"]+(")/,
      (_, before, after) => before + version + after
    );
    if (file === 'package-lock.json') {
      updated = updated.replace(
        /(""\s*:\s*\{[^}]*?"version"\s*:\s*")[^"]+(")/,
        (_, before, after) => before + version + after
      );
    }
    updates.push([target, updated]);
  }
  for (const [file, pattern] of [
    ['src-tauri/Cargo.toml', /(^version\s*=\s*")[^"]+("\s*$)/m],
    ['src-tauri/Cargo.lock', /(\[\[package\]\]\r?\nname = "yaoc"\r?\nversion = ")[^"]+(")/],
  ]) {
    const target = path.join(root, file);
    const text = fs.readFileSync(target, 'utf8');
    if (!pattern.test(text)) throw new Error(`Cannot find YAOC version in ${file}`);
    updates.push([target, text.replace(pattern, (_, before, after) => before + version + after)]);
  }
  const originals = updates.map(([target]) => [target, fs.readFileSync(target)]);
  try {
    for (const [target, text] of updates) fs.writeFileSync(target, text);
  } catch (error) {
    for (const [target, original] of originals) fs.writeFileSync(target, original);
    throw error;
  }
}

module.exports = { createBuildInfo, syncVersion };
