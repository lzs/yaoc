// Render the shared SVG into the PNG and multi-resolution ICO assets used by Tauri.
// Requires sharp (node scripts/generate-icons.cjs); no network access is used.
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
(async () => {
  const source = await fs.readFile(path.join(root, 'src/assets/yaoc.svg'));
  const output = path.join(root, 'src-tauri/icons');
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = await Promise.all(
    sizes.map((size) => sharp(source).resize(size, size).ensureAlpha().png().toBuffer())
  );
  await fs.mkdir(output, { recursive: true });
  for (const [name, size] of [
    ['32x32.png', 32],
    ['128x128.png', 128],
    ['128x128@2x.png', 256],
    ['icon.png', 512],
  ]) {
    await sharp(source).resize(size, size).ensureAlpha().png().toFile(path.join(output, name));
  }
  const directory = Buffer.alloc(6 + 16 * frames.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);
  let offset = directory.length;
  frames.forEach((frame, index) => {
    const start = 6 + index * 16;
    const size = sizes[index] === 256 ? 0 : sizes[index];
    directory[start] = size;
    directory[start + 1] = size;
    directory.writeUInt16LE(1, start + 4);
    directory.writeUInt16LE(32, start + 6);
    directory.writeUInt32LE(frame.length, start + 8);
    directory.writeUInt32LE(offset, start + 12);
    offset += frame.length;
  });
  await fs.writeFile(path.join(output, 'icon.ico'), Buffer.concat([directory, ...frames]));
  console.log('Generated YAOC PNGs and ICO with 16/24/32/48/64/128/256px frames.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
