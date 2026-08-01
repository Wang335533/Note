import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const viteConfig = await readFile(new URL("../vite.config.js", import.meta.url), "utf8");

test("release configuration avoids the self-extracting portable target", () => {
  const targets = Array.isArray(packageJson.build?.win?.target)
    ? packageJson.build.win.target
    : [packageJson.build?.win?.target].filter(Boolean);

  assert.deepEqual(targets, ["nsis"]);
  assert.equal(packageJson.build?.portable, undefined);
  assert.equal(packageJson.build?.nsis?.differentialPackage, false);
  assert.match(packageJson.scripts?.["package:installer"] || "", /--publish never/);
});

test("macOS release is one ad-hoc-signed universal DMG for Intel and Apple Silicon", () => {
  const target = packageJson.build?.mac?.target?.[0];
  assert.equal(target?.target, "dmg");
  assert.deepEqual(target?.arch, ["universal"]);
  assert.equal(packageJson.build?.mac?.identity, "-");
  assert.equal(packageJson.build?.mac?.hardenedRuntime, false);
  assert.equal(packageJson.build?.mac?.notarize, false);
  assert.equal(packageJson.build?.dmg?.artifactName, "Note-${version}-mac.${ext}");
  assert.match(packageJson.scripts?.["package:mac"] || "", /--mac dmg --universal --publish never/);
});

test("release contains only the locales the Chinese interface can use", () => {
  assert.deepEqual(packageJson.build?.electronLanguages, ["zh-CN", "zh-TW", "en-US"]);
});

test("browser preview prebundles every shared CommonJS entry", () => {
  for (const entry of [
    "desktop-note/store",
    "desktop-note/library-files",
    "desktop-note/rich-text",
  ]) {
    assert.match(viteConfig, new RegExp(`["']${entry}["']`));
  }
});

test("2.7.2 keeps the stable installation identity used by earlier notes", () => {
  assert.equal(packageJson.version, "2.7.2");
  assert.equal(packageJson.name, "desktop-note");
  assert.equal(packageJson.build?.appId, "local.desktop.note");
  assert.equal(packageJson.build?.productName, "Note");
});
