const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createBoundedFileLogger } = require("../electron/file-logger.cjs");

test("diagnostic logger stays bounded and keeps one rotated file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "note-log-test-"));
  try {
    const file = path.join(directory, "note-error.log");
    const logger = createBoundedFileLogger(file, {
      maxBytes: 180,
      now: () => new Date("2026-07-14T12:00:00.000Z"),
    });
    await logger.error("save failed", new Error("technical detail only"));
    await logger.warn("desktop mode failed", "window layer unavailable");
    await logger.error("quit failed", "disk unavailable");
    await logger.flush();

    const current = await fs.readFile(file, "utf8");
    const previous = await fs.readFile(`${file}.old`, "utf8");
    assert.ok(Buffer.byteLength(current) <= 180);
    assert.ok(Buffer.byteLength(previous) <= 180);
    assert.match(current, /\[(?:ERROR|WARN)\]/);
    assert.equal(current.includes("\n\n"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
