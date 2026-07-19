const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  compareVersions,
  completeUpgrade,
  createUpgradeSnapshot,
  readVersionMarker,
  restoreUpgradeSnapshot,
} = require("../electron/upgrade-guard.cjs");

async function withTempDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "note-upgrade-test-"));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("semantic versions compare without treating patch updates as fresh products", () => {
  assert.equal(compareVersions("2.0.0", "2.1.0"), -1);
  assert.equal(compareVersions("2.1.0", "2.1.0"), 0);
  assert.equal(compareVersions("2.2.0", "2.1.9"), 1);
});

test("upgrade snapshot keeps exactly one previous state and records completion", async () => {
  await withTempDirectory(async (directory) => {
    const first = { schemaVersion: 2, revision: 4, marker: "2.0 data" };
    const prepared = await createUpgradeSnapshot({
      dataDirectory: directory,
      rawState: first,
      currentVersion: "2.1.0",
      now: new Date("2026-07-19T00:00:00.000Z"),
    });
    assert.equal(prepared.required, true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "upgrade-backup", "state.json"), "utf8")), first);
    await completeUpgrade(directory, "2.1.0", new Date("2026-07-19T00:00:01.000Z"));
    assert.equal((await readVersionMarker(directory)).version, "2.1.0");

    const unchanged = await createUpgradeSnapshot({ dataDirectory: directory, rawState: first, currentVersion: "2.1.0" });
    assert.equal(unchanged.required, false);

    const second = { schemaVersion: 2, revision: 9, marker: "2.1 data" };
    await createUpgradeSnapshot({ dataDirectory: directory, rawState: second, currentVersion: "2.2.0" });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "upgrade-backup", "state.json"), "utf8")), second);
    await assert.rejects(fs.access(path.join(directory, "upgrade-backup.previous")));
  });
});

test("older app versions are refused before state can be overwritten", async () => {
  await withTempDirectory(async (directory) => {
    await completeUpgrade(directory, "2.2.0");
    await assert.rejects(
      createUpgradeSnapshot({ dataDirectory: directory, rawState: { revision: 1 }, currentVersion: "2.1.0" }),
      /不能用较旧的 2\.1\.0 覆盖/,
    );
  });
});

test("a failed migration can restore the pre-upgrade state atomically", async () => {
  await withTempDirectory(async (directory) => {
    const original = { schemaVersion: 2, revision: 7, marker: "safe" };
    const stateFile = path.join(directory, "state.json");
    await fs.writeFile(stateFile, JSON.stringify({ marker: "broken" }));
    await createUpgradeSnapshot({ dataDirectory: directory, rawState: original, currentVersion: "2.1.0" });
    await restoreUpgradeSnapshot(directory, stateFile);
    assert.deepEqual(JSON.parse(await fs.readFile(stateFile, "utf8")), original);
  });
});
