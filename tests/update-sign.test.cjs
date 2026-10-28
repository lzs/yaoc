const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { signRelease, DOMAIN } = require('../scripts/update-sign.cjs');

test('release signatures bind both architectures and reject wrong keys, Beta versions and swapped binaries', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yaoc-sign-test-'));
  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
    const identity = {
      formatVersion: 1,
      algorithm: 'ed25519',
      keyId: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16),
      publicKey: raw.toString('base64'),
    };
    const pem = privateKey.export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase: 'test passphrase only',
    });
    for (const [arch, machine] of [
      ['x64', 0x8664],
      ['arm64', 0xaa64],
    ]) {
      const bytes = Buffer.alloc(100);
      bytes.write('MZ');
      bytes.writeUInt32LE(64, 0x3c);
      bytes.write('PE\0\0', 64);
      bytes.writeUInt16LE(machine, 68);
      fs.writeFileSync(path.join(directory, `yaoc-${arch}.exe`), bytes);
    }
    const signed = signRelease(directory, '2026.2.0', pem, 'test passphrase only', identity);
    const payload = Buffer.from(signed.payload, 'base64');
    assert.equal(
      crypto.verify(
        null,
        Buffer.concat([DOMAIN, payload]),
        publicKey,
        Buffer.from(signed.signature, 'base64')
      ),
      true
    );
    assert.equal(JSON.parse(payload).assets.length, 2);
    const altered = Buffer.from(payload);
    altered[20] ^= 1;
    assert.equal(
      crypto.verify(
        null,
        Buffer.concat([DOMAIN, altered]),
        publicKey,
        Buffer.from(signed.signature, 'base64')
      ),
      false
    );
    assert.throws(
      () => signRelease(directory, '2026.2.0-dev10280000', pem, 'test passphrase only', identity),
      /official/
    );
    assert.throws(() => signRelease(directory, '2026.2.0', pem, 'wrong', identity));
    assert.throws(
      () =>
        signRelease(directory, '2026.2.0', pem, 'test passphrase only', {
          ...identity,
          keyId: 'other',
        }),
      /match/
    );
    fs.copyFileSync(path.join(directory, 'yaoc-x64.exe'), path.join(directory, 'yaoc-arm64.exe'));
    assert.throws(
      () => signRelease(directory, '2026.2.0', pem, 'test passphrase only', identity),
      /architecture/
    );
  } finally {
    // Only our known test files in this uniquely created directory.
    for (const name of ['yaoc-x64.exe', 'yaoc-arm64.exe'])
      fs.rmSync(path.join(directory, name), { force: true });
    fs.rmdirSync(directory);
  }
});
