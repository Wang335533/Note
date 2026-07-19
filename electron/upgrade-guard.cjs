const fs = require("node:fs/promises");
const path = require("node:path");

const VERSION_MARKER_NAME = "app-version.json";
const BACKUP_DIRECTORY_NAME = "upgrade-backup";

function parseVersion(value) {
  const match = String(value || "").trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function childPath(root, name) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, name);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Upgrade path escaped the data directory");
  return resolved;
}

async function readVersionMarker(dataDirectory) {
  const markerFile = childPath(dataDirectory, VERSION_MARKER_NAME);
  try {
    const marker = JSON.parse(await fs.readFile(markerFile, "utf8"));
    if (!parseVersion(marker?.version)) throw new Error("invalid version marker");
    return marker;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`无法读取版本标记：${error?.message || error}`);
  }
}

async function removeDirectoryWithin(dataDirectory, name) {
  const target = childPath(dataDirectory, name);
  await fs.rm(target, { recursive: true, force: true });
}

async function createUpgradeSnapshot({
  dataDirectory,
  rawState,
  sourceKind = "primary",
  currentVersion,
  now = new Date(),
}) {
  if (!parseVersion(currentVersion)) throw new Error("无效的应用版本");
  const marker = await readVersionMarker(dataDirectory);
  const previousVersion = marker?.version || null;
  const comparison = previousVersion ? compareVersions(previousVersion, currentVersion) : null;
  if (comparison === 1) {
    throw new Error(`本地数据已由 Note ${previousVersion} 使用，不能用较旧的 ${currentVersion} 覆盖。请安装 ${previousVersion} 或更高版本。`);
  }
  if (comparison === 0) return { required: false, previousVersion, currentVersion };

  const result = {
    required: true,
    previousVersion,
    currentVersion,
    hasSnapshot: Boolean(rawState),
    backupDirectory: childPath(dataDirectory, BACKUP_DIRECTORY_NAME),
  };
  if (!rawState) return result;

  const nextName = `${BACKUP_DIRECTORY_NAME}.next`;
  const previousName = `${BACKUP_DIRECTORY_NAME}.previous`;
  const nextDirectory = childPath(dataDirectory, nextName);
  const backupDirectory = result.backupDirectory;
  const previousDirectory = childPath(dataDirectory, previousName);
  await removeDirectoryWithin(dataDirectory, nextName);
  await fs.mkdir(nextDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(nextDirectory, "state.json"), `${JSON.stringify(rawState, null, 2)}\n`, { encoding: "utf8", flush: true }),
    fs.writeFile(path.join(nextDirectory, "metadata.json"), `${JSON.stringify({
      fromVersion: previousVersion || "unknown",
      toVersion: currentVersion,
      sourceKind,
      createdAt: now.toISOString(),
      attachmentPolicy: "managed attachments remain in place",
    }, null, 2)}\n`, { encoding: "utf8", flush: true }),
  ]);

  await removeDirectoryWithin(dataDirectory, previousName);
  try {
    await fs.rename(backupDirectory, previousDirectory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await fs.rename(nextDirectory, backupDirectory);
  } catch (error) {
    try {
      await fs.rename(previousDirectory, backupDirectory);
    } catch {
      // Preserve the original error; recovery remains possible from the previous directory.
    }
    throw error;
  }
  await removeDirectoryWithin(dataDirectory, previousName);
  return result;
}

async function completeUpgrade(dataDirectory, currentVersion, now = new Date()) {
  if (!parseVersion(currentVersion)) throw new Error("无效的应用版本");
  const markerFile = childPath(dataDirectory, VERSION_MARKER_NAME);
  const tempFile = childPath(dataDirectory, `${VERSION_MARKER_NAME}.tmp`);
  await fs.writeFile(tempFile, `${JSON.stringify({ version: currentVersion, completedAt: now.toISOString() }, null, 2)}\n`, {
    encoding: "utf8",
    flush: true,
  });
  try {
    await fs.rename(tempFile, markerFile);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
    await fs.rm(markerFile, { force: true });
    await fs.rename(tempFile, markerFile);
  }
}

async function restoreUpgradeSnapshot(dataDirectory, destinationFile) {
  const backupFile = childPath(dataDirectory, path.join(BACKUP_DIRECTORY_NAME, "state.json"));
  const destination = path.resolve(destinationFile);
  const root = path.resolve(dataDirectory);
  if (!destination.startsWith(`${root}${path.sep}`)) throw new Error("Restore path escaped the data directory");
  const restoreTemp = childPath(dataDirectory, "state.json.restore.tmp");
  await fs.copyFile(backupFile, restoreTemp);
  try {
    await fs.rename(restoreTemp, destination);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
    await fs.rm(destination, { force: true });
    await fs.rename(restoreTemp, destination);
  }
}

module.exports = {
  BACKUP_DIRECTORY_NAME,
  VERSION_MARKER_NAME,
  compareVersions,
  completeUpgrade,
  createUpgradeSnapshot,
  parseVersion,
  readVersionMarker,
  restoreUpgradeSnapshot,
};
