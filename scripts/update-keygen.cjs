// One-time Ed25519 signing identity for YAOC portable updates. Never prints secrets.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { Writable } = require('node:stream');
const { parseArgs } = require('node:util');
const repositoryRoot = path.resolve(__dirname, '..');
const PRIVATE_NAME = 'yaoc-update-private.pem';
const PUBLIC_NAME = 'yaoc-update-public.json';

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  );
}

function resolveThroughExistingParent(directory) {
  const missing = [];
  let parent = directory;
  while (!fs.existsSync(parent)) {
    missing.unshift(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) throw new Error('Cannot resolve output directory.');
    parent = next;
  }
  return path.join(fs.realpathSync(parent), ...missing);
}

function writeSigningKeys(directory, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12)
    throw new Error('Use a signing-key passphrase of at least 12 characters.');
  if (!directory || !path.isAbsolute(directory))
    throw new Error('--out must be an absolute directory outside the repository.');
  const output = path.resolve(directory);
  const actualOutput = resolveThroughExistingParent(output);
  if (isWithin(repositoryRoot, output) || isWithin(fs.realpathSync(repositoryRoot), actualOutput)) {
    throw new Error('Signing keys must be stored outside the repository.');
  }
  const privatePath = path.join(output, PRIVATE_NAME);
  const publicPath = path.join(output, PUBLIC_NAME);
  if (fs.existsSync(privatePath) || fs.existsSync(publicPath))
    throw new Error(
      'Signing key files already exist; refusing to replace them. Reuse the existing identity.'
    );
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicBytes = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const publicConfig = {
    formatVersion: 1,
    algorithm: 'ed25519',
    keyId: crypto.createHash('sha256').update(publicBytes).digest('hex').slice(0, 16),
    publicKey: publicBytes.toString('base64'),
  };
  const encrypted = privateKey.export({
    type: 'pkcs8',
    format: 'pem',
    cipher: 'aes-256-cbc',
    passphrase,
  });
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  let createdPrivate = false;
  try {
    fs.writeFileSync(privatePath, encrypted, { flag: 'wx', mode: 0o600 });
    createdPrivate = true;
    fs.writeFileSync(publicPath, JSON.stringify(publicConfig, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o644,
    });
  } catch (error) {
    // Only remove the private file exclusively created by this invocation.
    if (createdPrivate) fs.unlinkSync(privatePath);
    throw error;
  }
  return { privatePath, publicPath, publicConfig };
}

function readSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      'Run this command in an interactive terminal, or use --password-env with an environment variable name.'
    );
  return new Promise((resolve, reject) => {
    const muted = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const input = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    process.stdout.write(prompt);
    input.once('SIGINT', () => input.close());
    input.once('close', () => {
      muted.end();
      reject(new Error('Signing key generation cancelled.'));
    });
    input.question('', (value) => {
      process.stdout.write('\n');
      resolve(value);
      input.close();
    });
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      'password-env': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log('Usage: npm.cmd run updates:keygen -- --out <absolute-directory>');
    console.log(
      'Prompts for a hidden passphrase. Automation may use --password-env <VARIABLE_NAME>.'
    );
    return;
  }
  if (!values.out)
    throw new Error('Specify --out with an absolute directory outside the repository.');
  let passphrase;
  if (values['password-env']) {
    passphrase = process.env[values['password-env']];
    if (!passphrase) throw new Error('The named passphrase environment variable is empty.');
  } else {
    passphrase = await readSecret('Choose an update-signing passphrase (12+ characters; hidden): ');
    const confirmation = await readSecret('Confirm passphrase (hidden): ');
    if (passphrase !== confirmation)
      throw new Error('Passphrases did not match; no keys were written.');
  }
  const result = writeSigningKeys(values.out, passphrase);
  console.log('Encrypted private signing key: ' + result.privatePath);
  console.log('Public signing identity: ' + result.publicPath);
  console.log('Public key ID: ' + result.publicConfig.keyId);
  console.log(
    'Back up the private key and save its passphrase securely. Share only the public JSON file.'
  );
}

module.exports = { writeSigningKeys, readSecret, PRIVATE_NAME, PUBLIC_NAME };
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
