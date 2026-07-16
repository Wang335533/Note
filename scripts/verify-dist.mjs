import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(projectRoot, "dist");
const forbiddenFileNames = new Set([
  "state.json",
  "state.json.bak",
  "state.json.tmp",
  "note-error.log",
  "note-error.log.old",
]);
const forbiddenBundleMarkers = [
  "desktop-note-state-v1",
  "fixture-note-method",
  "fixture-notebook-research",
  "整理回归结果",
];

const indexHtml = await fs.readFile(path.join(distRoot, "index.html"), "utf8");
const rootRelativeAsset = indexHtml.match(/(?:src|href)=["']\/(?!\/)/i);
if (rootRelativeAsset) {
  throw new Error(
    `Desktop bundle contains a root-relative asset URL (${rootRelativeAsset[0]}). `
      + "Packaged file:// windows require relative asset URLs.",
  );
}

async function filesBelow(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

for (const file of await filesBelow(distRoot)) {
  if (forbiddenFileNames.has(path.basename(file).toLocaleLowerCase())) {
    throw new Error(`Desktop bundle contains a local state file: ${path.relative(distRoot, file)}`);
  }
  if (!/\.(?:js|html|css)$/i.test(file)) continue;
  const content = await fs.readFile(file, "utf8");
  const marker = forbiddenBundleMarkers.find((candidate) => content.includes(candidate));
  if (marker) {
    throw new Error(`Desktop bundle contains development fixture marker ${marker} in ${path.relative(distRoot, file)}`);
  }
}

console.log("Verified desktop bundle uses file-safe assets and contains no local state or development fixtures.");
