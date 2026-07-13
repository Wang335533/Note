const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_DETAIL_LENGTH = 4000;

function describeDetail(detail) {
  if (detail instanceof Error) return detail.stack || `${detail.name}: ${detail.message}`;
  if (detail === undefined || detail === null) return "";
  return String(detail);
}

function singleLine(value) {
  return String(value || "")
    .replace(/[\r\n]+/g, " ↩ ")
    .slice(0, MAX_DETAIL_LENGTH);
}

function createBoundedFileLogger(filePath, { maxBytes = DEFAULT_MAX_BYTES, now = () => new Date() } = {}) {
  if (!path.isAbsolute(filePath)) throw new TypeError("filePath must be absolute");
  if (!Number.isInteger(maxBytes) || maxBytes < 128) throw new TypeError("maxBytes must be at least 128");

  const previousFile = `${filePath}.old`;
  let queue = Promise.resolve();

  async function append(entry) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    let payload = Buffer.from(entry, "utf8");
    if (payload.length > maxBytes) payload = payload.subarray(payload.length - maxBytes);

    let currentSize = 0;
    try {
      currentSize = (await fs.stat(filePath)).size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    if (currentSize + payload.length > maxBytes) {
      await fs.rm(previousFile, { force: true });
      try {
        await fs.rename(filePath, previousFile);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    await fs.appendFile(filePath, payload);
  }

  function write(level, context, detail) {
    const timestamp = now().toISOString();
    const message = singleLine(describeDetail(detail));
    const entry = `${timestamp} [${level}] ${singleLine(context)}${message ? ` | ${message}` : ""}\n`;
    queue = queue.catch(() => {}).then(() => append(entry)).catch(() => {});
    return queue;
  }

  return {
    error(context, detail) {
      return write("ERROR", context, detail);
    },
    warn(context, detail) {
      return write("WARN", context, detail);
    },
    flush() {
      return queue;
    },
    filePath,
    previousFile,
  };
}

module.exports = { createBoundedFileLogger };
