import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("release configuration avoids the self-extracting portable target", () => {
  const targets = Array.isArray(packageJson.build?.win?.target)
    ? packageJson.build.win.target
    : [packageJson.build?.win?.target].filter(Boolean);

  assert.deepEqual(targets, ["nsis"]);
  assert.equal(packageJson.build?.portable, undefined);
  assert.equal(packageJson.build?.nsis?.differentialPackage, false);
  assert.doesNotMatch(packageJson.scripts?.["package:win"] || "", /portable/i);
});

test("release contains only the locales the Chinese interface can use", () => {
  assert.deepEqual(packageJson.build?.electronLanguages, ["zh-CN", "zh-TW", "en-US"]);
});

test("2.1 keeps the stable Windows installation identity used by earlier notes", () => {
  assert.equal(packageJson.version, "2.1.0");
  assert.equal(packageJson.name, "desktop-note");
  assert.equal(packageJson.build?.appId, "local.desktop.note");
  assert.equal(packageJson.build?.productName, "Note");
});
