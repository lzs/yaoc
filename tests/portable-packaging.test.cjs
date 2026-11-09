const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

test(
  'portable packaging produces replaceable ZIPs with exact payloads, notices and checksums',
  { skip: process.platform !== 'win32' },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yaoc portable [zip] 测试 '));
    try {
      fs.mkdirSync(path.join(root, 'scripts'));
      fs.copyFileSync(
        path.join(__dirname, '../scripts/package-portable.cjs'),
        path.join(root, 'scripts/package-portable.cjs')
      );
      fs.copyFileSync(
        path.join(__dirname, '../scripts/windows-signing.cjs'),
        path.join(root, 'scripts/windows-signing.cjs')
      );
      const notices = {
        LICENSE: 'Project license fixture',
        'THIRD_PARTY_LICENSES.txt': 'Third-party notice fixture',
      };
      for (const [name, content] of Object.entries(notices))
        fs.writeFileSync(path.join(root, name), content);
      const targets = [
        ['x64', 'x86_64-pc-windows-gnullvm'],
        ['arm64', 'aarch64-pc-windows-gnullvm'],
      ];
      fs.mkdirSync(path.join(root, 'release'));
      fs.writeFileSync(path.join(root, 'release/yaoc-setup.exe'), 'combined installer fixture');
      for (let generation = 0; generation < 2; generation++) {
        for (const [arch, triple] of targets) {
          const dir = path.join(root, 'src-tauri/target', triple, 'release');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(
            path.join(dir, 'yaoc.exe'),
            Buffer.from(`MZ\0${arch} payload ${generation}\xff`, 'latin1')
          );
        }
        const packaged = cp.spawnSync(
          process.execPath,
          [path.join(root, 'scripts/package-portable.cjs')],
          { encoding: 'utf8', env: { ...process.env, YAOC_AUTHENTICODE_THUMBPRINT: '' } }
        );
        assert.equal(
          packaged.status,
          0,
          packaged.error?.message || packaged.stdout + packaged.stderr
        );
        const release = path.join(root, 'release');
        const checksumLines = fs
          .readFileSync(path.join(release, 'SHA256SUMS.txt'), 'utf8')
          .trim()
          .split('\n');
        assert.equal(checksumLines.length, 5);
        assert(checksumLines.some((line) => line.endsWith('  yaoc-setup.exe')));
        for (const line of checksumLines) {
          const [expected, name] = line.split('  ');
          assert.equal(
            crypto
              .createHash('sha256')
              .update(fs.readFileSync(path.join(release, name)))
              .digest('hex'),
            expected
          );
        }
        for (const [arch, triple] of targets) {
          const destination = path.join(root, `extracted-${arch}-${generation}`);
          const extracted = cp.spawnSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:YAOC_TEST_ZIP, $env:YAOC_TEST_EXTRACT)",
            ],
            {
              encoding: 'utf8',
              env: {
                ...process.env,
                YAOC_TEST_ZIP: path.join(release, `yaoc-${arch}-portable.zip`),
                YAOC_TEST_EXTRACT: destination,
              },
            }
          );
          assert.equal(
            extracted.status,
            0,
            extracted.error?.message || extracted.stdout + extracted.stderr
          );
          assert.deepEqual(
            fs.readdirSync(destination).sort(),
            ['LICENSE', 'THIRD_PARTY_LICENSES.txt', `yaoc-${arch}.exe`].sort()
          );
          assert.deepEqual(
            fs.readFileSync(path.join(destination, `yaoc-${arch}.exe`)),
            fs.readFileSync(path.join(root, 'src-tauri/target', triple, 'release/yaoc.exe'))
          );
          for (const [name, content] of Object.entries(notices))
            assert.equal(fs.readFileSync(path.join(destination, name), 'utf8'), content);
          if (generation === 1)
            assert.deepEqual(
              fs.readFileSync(path.join(release, 'archive', `yaoc-${arch}.0.exe`)),
              Buffer.from(`MZ\0${arch} payload 0\xff`, 'latin1')
            );
        }
        assert(!fs.readdirSync(release).some((name) => name.includes('.tmp')));
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
