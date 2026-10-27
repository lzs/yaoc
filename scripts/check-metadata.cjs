const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const packageVersion = manifest.version;
const tauriVersion = JSON.parse(
  fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'))
).version;
const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (packageVersion !== tauriVersion || packageVersion !== cargoVersion) {
  console.error(
    `Version mismatch: npm=${packageVersion}, Tauri=${tauriVersion}, Cargo=${cargoVersion}`
  );
  process.exit(1);
}
console.log(`App metadata versions agree: ${packageVersion}`);

const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
const cargoLock = fs.readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8');
const cargoLockVersion = cargoLock.match(
  /\[\[package\]\]\r?\nname = "yaoc"\r?\nversion = "([^"]+)"/
)?.[1];
if (
  lock.version !== packageVersion ||
  lock.packages[''].version !== packageVersion ||
  cargoLockVersion !== packageVersion
) {
  console.error('App lockfile versions must match package metadata.');
  process.exit(1);
}
if (
  manifest.license !== 'MIT' ||
  lock.packages[''].license !== 'MIT' ||
  !/^license\s*=\s*"MIT"$/m.test(cargo)
) {
  console.error('Project license metadata must agree: MIT');
  process.exit(1);
}
const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
if (!/^MIT License\r?\n/.test(license) || !/^Copyright \(c\) \d{4} .+$/m.test(license)) {
  console.error('The project MIT license notice is missing or inconsistent.');
  process.exit(1);
}
console.log('Project license metadata agrees: MIT');
