const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyRelease } = require('../scripts/update-verify.cjs');
const fixture = require('./fixtures/update-manifest.json');

test('release verifier accepts signed artifacts and rejects signature, binary and checksum tampering', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yaoc-verify-'));
  const names = [
    'yaoc-x64.exe',
    'yaoc-arm64.exe',
    'latest.json',
    'SHA256SUMS.txt',
    'LICENSE',
    'THIRD_PARTY_LICENSES.txt',
  ];
  const manifest = JSON.parse(Buffer.from(fixture.envelope.payload, 'base64'));
  const envelope = JSON.stringify(fixture.envelope);
  try {
    for (const [name, machine] of [
      ['yaoc-x64.exe', 0x8664],
      ['yaoc-arm64.exe', 0xaa64],
    ]) {
      const bytes = Buffer.alloc(100);
      bytes.write('MZ');
      bytes.writeUInt32LE(64, 0x3c);
      bytes.write('PE\0\0', 64);
      bytes.writeUInt16LE(machine, 68);
      fs.writeFileSync(path.join(directory, name), bytes);
    }
    fs.writeFileSync(path.join(directory, 'latest.json'), envelope);
    const checksums = manifest.assets.map((a) => `${a.sha256}  ${a.name}`).join('\n') + '\n';
    fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), checksums);
    fs.writeFileSync(path.join(directory, 'LICENSE'), 'Test notice');
    fs.writeFileSync(path.join(directory, 'THIRD_PARTY_LICENSES.txt'), 'Test notices');
    assert.equal(verifyRelease(directory, fixture.identity).version, '2026.2.0');
    assert.throws(() => verifyRelease(directory), /signing key/);
    fs.writeFileSync(
      path.join(directory, 'latest.json'),
      JSON.stringify({ ...fixture.envelope, signature: Buffer.alloc(64).toString('base64') })
    );
    assert.throws(
      () => verifyRelease(directory, fixture.identity),
      /signature verification failed/
    );
    fs.writeFileSync(path.join(directory, 'latest.json'), envelope);
    const binary = path.join(directory, 'yaoc-x64.exe');
    const original = fs.readFileSync(binary);
    const changed = Buffer.from(original);
    changed[99] ^= 1;
    fs.writeFileSync(binary, changed);
    assert.throws(() => verifyRelease(directory, fixture.identity), /SHA-256 mismatch/);
    fs.writeFileSync(binary, original.subarray(0, 99));
    assert.throws(() => verifyRelease(directory, fixture.identity), /size mismatch/);
    fs.writeFileSync(binary, original);
    fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), checksums.replace(/[a-f0-9]/, 'z'));
    assert.throws(() => verifyRelease(directory, fixture.identity), /SHA256SUMS.txt mismatch/);
    fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), checksums);
    fs.unlinkSync(path.join(directory, 'LICENSE'));
    assert.throws(() => verifyRelease(directory, fixture.identity), /ENOENT/);
  } finally {
    for (const name of names) fs.rmSync(path.join(directory, name), { force: true });
    fs.rmdirSync(directory);
  }
});
