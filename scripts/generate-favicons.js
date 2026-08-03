// Generates rounded-edge app icons from the source favicon.png in the project root.
// Run: node scripts/generate-favicons.js
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const source = path.join(root, 'favicon.png');
const staticDir = path.join(root, 'static');

// size = output px, radiusRatio = corner radius as a fraction of the size
const targets = [
  { file: 'favicon-32.png', size: 32, radiusRatio: 0.22 },
  { file: 'favicon-48.png', size: 48, radiusRatio: 0.22 },
  { file: 'apple-touch-icon.png', size: 180, radiusRatio: 0.22 },
];

function roundedMask(size, radius) {
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}"/>
  </svg>`;
  return Buffer.from(svg);
}

async function build() {
  for (const { file, size, radiusRatio } of targets) {
    const radius = Math.round(size * radiusRatio);
    const mask = roundedMask(size, radius);

    const resized = await sharp(source)
      .resize(size, size, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();

    await sharp(resized)
      .composite([{ input: mask, blend: 'dest-in' }])
      .png()
      .toFile(path.join(staticDir, file));

    console.log(`wrote static/${file} (${size}x${size}, radius ${radius}px)`);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
