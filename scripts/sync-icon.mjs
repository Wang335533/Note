import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "node_modules", "@phosphor-icons", "core", "assets", "regular", "note-pencil.svg");
const targetDirectory = path.join(root, "assets");

await mkdir(targetDirectory, { recursive: true });
await copyFile(source, path.join(targetDirectory, "note.svg"));

const glyph = await sharp(source)
  .resize(360, 360, { fit: "contain" })
  .tint("#6266ee")
  .png()
  .toBuffer();

const icon = await sharp({
  create: {
    width: 512,
    height: 512,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
}).composite([{ input: glyph, left: 76, top: 76 }]).png().toBuffer();

await sharp(icon).png().toFile(path.join(targetDirectory, "note.png"));
await sharp(icon).resize(32, 32).png().toFile(path.join(targetDirectory, "note-tray.png"));
