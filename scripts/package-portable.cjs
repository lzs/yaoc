// Stage the two portable builds and keep three rollback generations.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const release = path.join(root, 'release');
const archive = path.join(release, 'archive');
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
  for (const { source } of sources) require('./windows-signing.cjs').verifySignedFile(source);
  fs.mkdirSync(release, { recursive: true });
  fs.mkdirSync(archive, { recursive: true });
  const inUse = path.join(archive, '.in-use');
  fs.mkdirSync(inUse, { recursive: true });
  for (const name of fs.readdirSync(inUse)) {
    if (/^yaoc-(x64|arm64)-\d+-\d+\.exe$/.test(name)) {
      try {
        fs.rmSync(path.join(inUse, name));
      } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      }
    }
  }
  for (const { arch, source } of sources) {
    const base = path.join(release, `yaoc-${arch}`);
    const backupBase = path.join(archive, `yaoc-${arch}`);
    const staged = `${base}.${process.pid}.tmp`;
    try {
      fs.copyFileSync(source, staged);
      if (hash(source) !== hash(staged))
        throw new Error(`Staged ${arch} executable failed verification`);
      try {
        fs.rmSync(backupBase + '.2.exe', { force: true });
      } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        // Windows permits renaming a running image but not deleting it. Preserve the
        // live image outside the three rollback slots until a later packaging run can remove it.
        const held = path.join(
          inUse,
          'yaoc-' + arch + '-' + Date.now() + '-' + process.pid + '.exe'
        );
        fs.renameSync(backupBase + '.2.exe', held);
        console.log('Old running image retained until it exits: ' + held);
      }
      for (const [old, next] of [
        ['.1.exe', '.2.exe'],
        ['.0.exe', '.1.exe'],
      ]) {
        if (fs.existsSync(backupBase + old)) fs.renameSync(backupBase + old, backupBase + next);
      }
      if (fs.existsSync(base + '.exe')) fs.renameSync(base + '.exe', backupBase + '.0.exe');
      fs.renameSync(staged, `${base}.exe`);
      console.log(`Staged yaoc-${arch}.exe`);
    } finally {
      fs.rmSync(staged, { force: true });
    }
  }
  for (const name of ['LICENSE', 'THIRD_PARTY_LICENSES.txt']) {
    fs.copyFileSync(path.join(root, name), path.join(release, name));
  }
  const artifacts = [];
  for (const { arch } of sources) {
    const executable = `yaoc-${arch}.exe`;
    const zip = `yaoc-${arch}-portable.zip`;
    const stagedZip = path.join(release, `yaoc-${arch}-portable.${process.pid}.tmp.zip`);
    try {
      const result = cp.spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `
            $ErrorActionPreference = 'Stop'
            Add-Type -AssemblyName System.IO.Compression
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $zip = [IO.Compression.ZipFile]::Open($env:YAOC_PORTABLE_ZIP, [IO.Compression.ZipArchiveMode]::Create)
            try {
              foreach ($file in @($env:YAOC_PORTABLE_EXE, $env:YAOC_PORTABLE_LICENSE, $env:YAOC_PORTABLE_NOTICES)) {
                [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file, [IO.Path]::GetFileName($file), [IO.Compression.CompressionLevel]::Optimal) | Out-Null
              }
            } finally {
              $zip.Dispose()
            }
          `,
        ],
        {
          stdio: 'inherit',
          env: {
            ...process.env,
            YAOC_PORTABLE_EXE: path.join(release, executable),
            YAOC_PORTABLE_LICENSE: path.join(release, 'LICENSE'),
            YAOC_PORTABLE_NOTICES: path.join(release, 'THIRD_PARTY_LICENSES.txt'),
            YAOC_PORTABLE_ZIP: stagedZip,
          },
        }
      );
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`ZIP packaging failed for ${arch}`);
      fs.renameSync(stagedZip, path.join(release, zip));
      artifacts.push(executable, zip);
      console.log(`Packaged ${zip}`);
    } finally {
      fs.rmSync(stagedZip, { force: true });
    }
  }
  if (fs.existsSync(path.join(release, 'yaoc-setup.exe'))) artifacts.push('yaoc-setup.exe');
  fs.writeFileSync(
    path.join(release, 'SHA256SUMS.txt'),
    artifacts.map((name) => `${hash(path.join(release, name))}  ${name}`).join('\n') + '\n'
  );
} catch (error) {
  console.error(`Packaging failed: ${error.message}`);
  console.error(
    'If a backup is locked by a running app, quit that instance before retrying. Existing backups are not silently skipped.'
  );
  process.exitCode = 1;
}
