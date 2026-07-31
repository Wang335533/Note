import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "node_modules", "@phosphor-icons", "core", "assets", "regular", "note-pencil.svg");
const targetDirectory = path.join(root, "assets");

await mkdir(targetDirectory, { recursive: true });
await copyFile(source, path.join(targetDirectory, "note.svg"));
const sourceSvg = await readFile(source, "utf8");
const accentSource = Buffer.from(sourceSvg.replace("currentColor", "#d97757"));
const templateSource = Buffer.from(sourceSvg.replace("currentColor", "#000000"));

const glyph = await sharp(accentSource)
  .resize(720, 720, { fit: "contain" })
  .png()
  .toBuffer();

const icon = await sharp({
  create: {
    width: 1024,
    height: 1024,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
}).composite([{ input: glyph, left: 152, top: 152 }]).png().toBuffer();

await sharp(icon).png().toFile(path.join(targetDirectory, "note.png"));
await sharp(icon).resize(32, 32).png().toFile(path.join(targetDirectory, "note-tray.png"));

const macBackground = Buffer.from(`
  <svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fffdfb"/>
        <stop offset="1" stop-color="#f1e8e0"/>
      </linearGradient>
    </defs>
    <rect x="64" y="64" width="896" height="896" rx="220" fill="url(#paper)"/>
    <rect x="65" y="65" width="894" height="894" rx="219" fill="none" stroke="#ded1c7" stroke-width="10"/>
  </svg>
`);
const macGlyph = await sharp(accentSource)
  .resize(560, 560, { fit: "contain" })
  .png()
  .toBuffer();
await sharp({
  create: {
    width: 1024,
    height: 1024,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
}).composite([
  { input: macBackground, left: 0, top: 0 },
  { input: macGlyph, left: 232, top: 232 },
]).png().toFile(path.join(targetDirectory, "note-mac.png"));

const templateGlyph = async (size) => sharp(templateSource)
  .resize(size - 4, size - 4, { fit: "contain" })
  .png()
  .toBuffer();
const writeTemplate = async (size, fileName) => {
  const glyphBuffer = await templateGlyph(size);
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([{ input: glyphBuffer, left: 2, top: 2 }]).png().toFile(path.join(targetDirectory, fileName));
};
await writeTemplate(16, "note-trayTemplate.png");
await writeTemplate(32, "note-trayTemplate@2x.png");
