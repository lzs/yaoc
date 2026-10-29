// Called by makensis after Tauri patches the executable with its bundle type,
// before Tauri restores its original build output. Preserve these exact payload bytes.
const fs = require('node:fs');
const path = require('node:path');
const source = path.resolve(process.argv[2] || '');
const targetRoot = path.resolve(__dirname, '../src-tauri/target') + path.sep;
if (
  !source.toLowerCase().startsWith(targetRoot.toLowerCase()) ||
  path.basename(source) !== 'yaoc.exe'
)
  throw new Error('Unexpected installer payload path');
const bytes = fs.readFileSync(source);
if (!bytes.includes(Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS')))
  throw new Error('NSIS bundle marker is missing');
fs.writeFileSync(source + '.nsis-payload.exe', bytes);
