const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { writeSigningKeys, PRIVATE_NAME, PUBLIC_NAME } = require('../scripts/update-keygen.cjs');

function temporaryKeys(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yaoc-update-key-test-'));
  t.after(() => {
    // These fixtures only create two files: avoid recursive cleanup entirely.
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  return directory;
}
const passphrase = 'test-only-signing-passphrase';

test('generated private keys are encrypted and the public identity verifies signatures', (t) => {
  const directory = temporaryKeys(t);
  const result = writeSigningKeys(directory, passphrase);
  const encrypted = fs.readFileSync(result.privatePath, 'utf8');
  assert.match(encrypted, /^-----BEGIN ENCRYPTED PRIVATE KEY-----/);
  assert.throws(() => crypto.createPrivateKey({ key: encrypted, passphrase: 'wrong-password' }));
  const privateKey = crypto.createPrivateKey({ key: encrypted, passphrase });
  const publicKey = crypto.createPublicKey(privateKey);
  const config = JSON.parse(fs.readFileSync(result.publicPath, 'utf8'));
  assert.equal(config.algorithm, 'ed25519');
  assert.equal(
    config.publicKey,
    Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64')
  );
  assert.equal(Buffer.from(config.publicKey, 'base64').length, 32);
  const payload = Buffer.from('example updater artifact');
  const signature = crypto.sign(null, payload, privateKey);
  assert.equal(crypto.verify(null, payload, publicKey, signature), true);
  assert.equal(crypto.verify(null, Buffer.from('tampered artifact'), publicKey, signature), false);
  assert.ok(!JSON.stringify(config).includes('PRIVATE KEY'));
});

test('existing signing identities are not overwritten', (t) => {
  const directory = temporaryKeys(t);
  writeSigningKeys(directory, passphrase);
  const before = fs.readFileSync(path.join(directory, PRIVATE_NAME));
  assert.throws(() => writeSigningKeys(directory, passphrase), /already exist/);
  assert.deepEqual(fs.readFileSync(path.join(directory, PRIVATE_NAME)), before);
});

test('key generation rejects repository destinations and weak passphrases', () => {
  assert.throws(
    () => writeSigningKeys(path.resolve('.local', 'must-not-create-update-key'), passphrase),
    /outside the repository/
  );
  assert.throws(
    () => writeSigningKeys(path.join(os.tmpdir(), 'unused-key-path'), 'short'),
    /12 characters/
  );
  assert.throws(() => writeSigningKeys('relative/path', passphrase), /absolute directory/);
});

test('the CLI writes keys without printing the passphrase or private key', (t) => {
  const directory = temporaryKeys(t);
  const result = spawnSync(
    process.execPath,
    [
      'scripts/update-keygen.cjs',
      '--out',
      directory,
      '--password-env',
      'YAOC_TEST_SIGNING_PASSPHRASE',
    ],
    {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, YAOC_TEST_SIGNING_PASSPHRASE: passphrase },
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(passphrase));
  assert.ok(!result.stdout.includes('BEGIN ENCRYPTED PRIVATE KEY'));
  assert.ok(fs.existsSync(path.join(directory, PRIVATE_NAME)));
  assert.ok(fs.existsSync(path.join(directory, PUBLIC_NAME)));
});
