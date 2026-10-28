// Sign official portable release metadata. Private keys never enter the repository.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const { readSecret } = require('./update-keygen.cjs');
const root = path.resolve(__dirname, '..');
const DOMAIN = Buffer.from('YAOC-UPDATE-V1\n');

function signRelease(directory, version, privatePem, passphrase, identity) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error('Only official major.minor.patch versions may be signed.');
  const key = crypto.createPrivateKey({ key: privatePem, passphrase });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 key is required.');
  const publicBytes = Buffer.from(
    crypto.createPublicKey(key).export({ format: 'jwk' }).x,
    'base64url'
  );
  const keyId = crypto.createHash('sha256').update(publicBytes).digest('hex').slice(0, 16);
  if (
    identity.formatVersion !== 1 ||
    identity.algorithm !== 'ed25519' ||
    identity.publicKey !== publicBytes.toString('base64') ||
    identity.keyId !== keyId
  )
    throw new Error('Signing key does not match the public identity embedded in YAOC.');
  const assets = [
    ['yaoc-x64.exe', 0x8664],
    ['yaoc-arm64.exe', 0xaa64],
  ].map(([name, machine]) => {
    const data = fs.readFileSync(path.join(directory, name));
    // Reject swapped architectures and accidental text/installer inputs.
    const pe = data.length >= 64 ? data.readUInt32LE(0x3c) : 0;
    if (
      data.length < 64 ||
      data.toString('ascii', 0, 2) !== 'MZ' ||
      pe < 64 ||
      pe + 6 > data.length ||
      data.toString('ascii', pe, pe + 4) !== 'PE\0\0' ||
      data.readUInt16LE(pe + 4) !== machine
    )
      throw new Error(`Invalid executable architecture: ${name}`);
    if (data.length > 200 * 1024 * 1024) throw new Error('Executable exceeds updater size limit.');
    return {
      name,
      size: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
    };
  });
  const payload = Buffer.from(
    JSON.stringify({ formatVersion: 1, version, channel: 'official', assets })
  );
  const signature = crypto.sign(null, Buffer.concat([DOMAIN, payload]), key);
  const document = {
    keyId,
    payload: payload.toString('base64'),
    signature: signature.toString('base64'),
  };
  // Verify our own output before writing anything publishable.
  if (
    !crypto.verify(null, Buffer.concat([DOMAIN, payload]), crypto.createPublicKey(key), signature)
  )
    throw new Error('Signature self-check failed.');
  return document;
}

async function main() {
  const { values } = parseArgs({
    options: {
      key: { type: 'string' },
      'key-env': { type: 'string' },
      'password-env': { type: 'string' },
      dir: { type: 'string', default: path.join(root, 'release') },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log('npm.cmd run updates:sign -- --key <private.pem> [--password-env VARIABLE_NAME]');
    console.log(
      'Automation may use --key-env VARIABLE_NAME instead of --key. Signs the official version in package.json.'
    );
    return;
  }
  if (!!values.key === !!values['key-env'])
    throw new Error('Specify exactly one of --key or --key-env.');
  const privatePem = values.key
    ? fs.readFileSync(values.key, 'utf8')
    : process.env[values['key-env']];
  if (!privatePem || !privatePem.includes('BEGIN ENCRYPTED PRIVATE KEY'))
    throw new Error('An encrypted PKCS8 private key is required.');
  const passphrase = values['password-env']
    ? process.env[values['password-env']]
    : await readSecret('Update-signing passphrase (hidden): ');
  if (!passphrase) throw new Error('The signing passphrase is empty.');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
  const identity = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/update-public.json')));
  const document = signRelease(values.dir, version, privatePem, passphrase, identity);
  fs.writeFileSync(path.join(values.dir, 'latest.json'), JSON.stringify(document, null, 2) + '\n');
  console.log(`Signed official release ${version} with key ${identity.keyId}. Wrote latest.json.`);
}
module.exports = { signRelease, DOMAIN };
if (require.main === module)
  main().catch((error) => {
    // Crypto parser errors contain no key material; never print the inputs.
    console.error(`Update signing failed: ${error.message}`);
    process.exitCode = 1;
  });
