// Read-only release verification. Never reads a private key or executes a binary.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const root = path.resolve(__dirname, '..');

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function verifyRelease(
  directory,
  identity = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/update-public.json'), 'utf8'))
) {
  const manifestPath = path.join(directory, 'latest.json');
  requireCondition(fs.statSync(manifestPath).size <= 65536, 'Manifest exceeds size limit.');
  const envelope = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const publicBytes = Buffer.from(identity.publicKey, 'base64');
  requireCondition(
    identity.formatVersion === 1 && identity.algorithm === 'ed25519' && publicBytes.length === 32,
    'Invalid embedded public identity.'
  );
  requireCondition(
    crypto.createHash('sha256').update(publicBytes).digest('hex').slice(0, 16) === identity.keyId,
    'Embedded key ID does not match its public key.'
  );
  requireCondition(
    envelope.keyId === identity.keyId,
    'Manifest signing key does not match the embedded public identity.'
  );
  requireCondition(
    typeof envelope.payload === 'string' && typeof envelope.signature === 'string',
    'Invalid signed envelope.'
  );
  const payload = Buffer.from(envelope.payload, 'base64');
  const signature = Buffer.from(envelope.signature, 'base64');
  const publicKey = crypto.createPublicKey({
    format: 'jwk',
    key: { kty: 'OKP', crv: 'Ed25519', x: publicBytes.toString('base64url') },
  });
  requireCondition(
    signature.length === 64 &&
      crypto.verify(
        null,
        Buffer.concat([Buffer.from('YAOC-UPDATE-V1\n'), payload]),
        publicKey,
        signature
      ),
    'Manifest signature verification failed.'
  );
  const manifest = JSON.parse(payload);
  requireCondition(
    manifest.formatVersion === 1 &&
      manifest.channel === 'official' &&
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version),
    'Invalid official release metadata.'
  );
  requireCondition(
    Array.isArray(manifest.assets) && manifest.assets.length === 2,
    'Manifest must contain both architectures exactly once.'
  );
  const checksums = fs
    .readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8')
    .trim()
    .split(/\r?\n/);
  requireCondition(checksums.length === 2, 'Expected two executable checksums.');
  for (const name of ['yaoc-x64.exe', 'yaoc-arm64.exe']) {
    const matches = manifest.assets.filter((asset) => asset.name === name);
    requireCondition(matches.length === 1, `Missing or duplicate signed asset: ${name}`);
    const asset = matches[0];
    requireCondition(
      Number.isSafeInteger(asset.size) &&
        asset.size > 0 &&
        asset.size <= 200 * 1024 * 1024 &&
        /^[a-f0-9]{64}$/.test(asset.sha256),
      `Invalid signed metadata: ${name}`
    );
    const file = path.join(directory, name);
    const stat = fs.statSync(file);
    requireCondition(stat.isFile() && stat.size === asset.size, `Signed size mismatch: ${name}`);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    requireCondition(hash === asset.sha256, `Signed SHA-256 mismatch: ${name}`);
    requireCondition(checksums.includes(`${hash}  ${name}`), `SHA256SUMS.txt mismatch: ${name}`);
  }
  for (const name of ['LICENSE', 'THIRD_PARTY_LICENSES.txt']) {
    const stat = fs.statSync(path.join(directory, name));
    requireCondition(stat.isFile() && stat.size > 0, `Missing or empty release notice: ${name}`);
  }
  return { version: manifest.version, keyId: identity.keyId };
}

function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string', default: path.join(root, 'release') },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log('npm.cmd run updates:verify -- --dir "release\\2026.1.0"');
    console.log(
      'Checks the public-key signature, both executable sizes/hashes, checksum consistency, and required notices. Makes no changes.'
    );
    return;
  }
  const result = verifyRelease(values.dir);
  console.log(`PASS: official YAOC ${result.version}, signed by embedded key ${result.keyId}.`);
  console.log('PASS: both executable sizes and SHA-256 hashes match the signed manifest.');
  console.log('PASS: SHA256SUMS.txt agrees and required licence files are present.');
}

module.exports = { verifyRelease };
if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Verification FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
