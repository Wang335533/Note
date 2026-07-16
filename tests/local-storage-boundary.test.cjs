const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const mainSource = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
const browserApiSource = fs.readFileSync(path.join(root, "src", "api.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("desktop content is rooted in the current installation's per-user data directory", () => {
  assert.match(mainSource, /app\.getPath\("userData"\)/);
  assert.match(mainSource, /path\.join\(app\.getPath\("userData"\), "note-data"\)/);
  assert.match(mainSource, /path\.join\(dataDirectory, "attachments"\)/);
});

test("renderer network policy has no remote synchronization endpoint", () => {
  const policy = indexHtml.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] || "";
  const connectSource = policy.match(/connect-src ([^;]+);/)?.[1] || "";
  assert.match(connectSource, /^'self' ws:\/\/127\.0\.0\.1:\* http:\/\/127\.0\.0\.1:\*$/);
  assert.doesNotMatch(connectSource, /https?:\/\/(?!127\.0\.0\.1)/);
});

test("release inputs cannot bundle local state, browser storage, or developer fixtures as user data", () => {
  assert.deepEqual(packageJson.dependencies || {}, {});
  assert.deepEqual(packageJson.build.files, [
    "dist/**/*",
    "electron/**/*",
    "shared/**/*",
    "assets/**/*",
    "package.json",
  ]);
  assert.equal(packageJson.build.files.some((entry) => /state|note-data|localStorage|fixture|release/i.test(entry)), false);
  assert.match(browserApiSource, /browserPreviewEnabled = import\.meta\.env\?\.DEV/);
  assert.match(browserApiSource, /browserWindow\?\.noteDesktop\s*\|\|/);
});
