// Stage the two portable builds and keep three rollback generations.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const release = path.join(root, 'release');
const targets = [
  ['x64', 'x86_64-pc-windows-gnullvm'],
  ['arm64', 'aarch64-pc-windows-gnullvm'],
];
const sources = targets.map(([arch, triple]) => ({
  arch,
  source: path.join(root, 'src-tauri/target', triple, 'release/yaoc.exe'),
}));
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  for (const name of ['LICENSE', 'THIRD_PARTY_LICENSES.txt']) {
    if (!fs.statSync(path.join(root, name)).isFile())
      throw new Error(`Missing required distribution notice: ${name}`);
  }
  for (const { source } of sources)
    if (!fs.statSync(source).isFile()) throw new Error(`Missing build: ${source}`);
  fs.mkdirSync(release, { recursive: true });
  for (const { arch, source } of sources) {
    const base = path.join(release, `yaoc-${arch}`);
    const staged = `${base}.${process.pid}.tmp`;
    try {
      fs.copyFileSync(source, staged);
      if (hash(source) !== hash(staged))
        throw new Error(`Staged ${arch} executable failed verification`);
      fs.rmSync(`${base}.2.exe`, { force: true });
      for (const [old, next] of [
        ['.1.exe', '.2.exe'],
        ['.0.exe', '.1.exe'],
        ['.exe', '.0.exe'],
      ]) {
        if (fs.existsSync(base + old)) fs.renameSync(base + old, base + next);
      }
      fs.renameSync(staged, `${base}.exe`);
      console.log(`Staged yaoc-${arch}.exe`);
    } finally {
      fs.rmSync(staged, { force: true });
    }
  }
  for (const name of ['LICENSE', 'THIRD_PARTY_LICENSES.txt']) {
    fs.copyFileSync(path.join(root, name), path.join(release, name));
  }
  fs.writeFileSync(
    path.join(release, 'SHA256SUMS.txt'),
    sources
      .map(({ arch }) => `${hash(path.join(release, `yaoc-${arch}.exe`))}  yaoc-${arch}.exe`)
      .join('\n') + '\n'
  );
} catch (error) {
  console.error(`Packaging failed: ${error.message}`);
  console.error(
    'If a backup is locked by a running app, quit that instance before retrying. Existing backups are not silently skipped.'
  );
  process.exitCode = 1;
}
