import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const gitignore = await readFile(new URL(".gitignore", root), "utf8");
const ci = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
const release = await readFile(new URL(".github/workflows/release.yml", root), "utf8");

test("public package metadata points to the canonical GitHub repository", () => {
  assert.equal(packageJson.license, "MIT");
  assert.equal(packageJson.engines?.node, ">=22.12.0");
  assert.equal(packageJson.repository?.url, "git+https://github.com/Wang335533/Note.git");
  assert.equal(packageJson.bugs?.url, "https://github.com/Wang335533/Note/issues");
});

test("known vulnerable development dependencies stay on patched versions", () => {
  assert.equal(packageJson.devDependencies?.["@floating-ui/dom"], "1.8.0");
  assert.equal(packageJson.devDependencies?.vite, "6.4.3");
  assert.equal(packageJson.overrides?.["shell-quote"], "1.10.0");
});

test("CI uses locked dependencies with read-only repository access", () => {
  assert.match(ci, /permissions:\s*\n\s*contents: read/);
  assert.match(ci, /actions\/checkout@v6/);
  assert.match(ci, /actions\/setup-node@v6/);
  assert.match(ci, /node-version: 24/);
  assert.match(ci, /npm ci/);
  assert.match(ci, /npm test/);
  assert.match(ci, /npm run build/);
});

test("tagged Windows releases are version-checked and published with a checksum", () => {
  assert.match(release, /tags:\s*\n\s*- ["']v\*\.\*\.\*["']/);
  assert.match(release, /permissions:\s*\n\s*contents: write/);
  assert.match(release, /GITHUB_REF_NAME/);
  assert.match(release, /actions\/checkout@v6/);
  assert.match(release, /actions\/setup-node@v6/);
  assert.match(release, /node-version: 24/);
  assert.match(release, /npm run package:installer/);
  assert.match(release, /Get-FileHash/);
  assert.match(release, /SHA256SUMS\.txt/);
  assert.match(release, /gh release create/);
});

test("generated installers stay out of Git history", () => {
  assert.ok(gitignore.split(/\r?\n/).includes("release/"));
});
