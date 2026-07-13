const test = require("node:test");
const assert = require("node:assert/strict");
const { isSameDocumentUrl, isTrustedRendererEvent } = require("../electron/ipc-security.cjs");

function trustedFrame(overrides = {}) {
  return {
    url: "file:///note/dist/index.html",
    parent: null,
    detached: false,
    isDestroyed: () => false,
    ...overrides,
  };
}

test("trusted top-level IPC does not depend on WebFrameMain object identity", () => {
  const webContents = { isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: trustedFrame() };
  const unrelatedMainFrameProxy = trustedFrame();

  assert.notEqual(event.senderFrame, unrelatedMainFrameProxy);
  assert.equal(
    isTrustedRendererEvent(event, webContents, (url) => url === "file:///note/dist/index.html"),
    true,
  );
});

test("IPC validation rejects other windows, child frames, detached frames, and bad URLs", () => {
  const webContents = { isDestroyed: () => false };
  const allowed = (url) => url === "file:///note/dist/index.html";

  assert.equal(isTrustedRendererEvent({ sender: {}, senderFrame: trustedFrame() }, webContents, allowed), false);
  assert.equal(isTrustedRendererEvent({ sender: webContents, senderFrame: trustedFrame({ parent: {} }) }, webContents, allowed), false);
  assert.equal(isTrustedRendererEvent({ sender: webContents, senderFrame: trustedFrame({ detached: true }) }, webContents, allowed), false);
  assert.equal(isTrustedRendererEvent({ sender: webContents, senderFrame: trustedFrame({ url: "https://example.com" }) }, webContents, allowed), false);
  assert.equal(isTrustedRendererEvent({ sender: webContents, senderFrame: null }, webContents, allowed), false);
});

test("current renderer URL comparison ignores only query and hash", () => {
  assert.equal(
    isSameDocumentUrl(
      "file:///C:/Temp/portable/resources/app.asar/dist/index.html?capture=1#today",
      "file:///C:/Temp/portable/resources/app.asar/dist/index.html",
    ),
    true,
  );
  assert.equal(
    isSameDocumentUrl(
      "file:///C:/Temp/other/resources/app.asar/dist/index.html",
      "file:///C:/Temp/portable/resources/app.asar/dist/index.html",
    ),
    false,
  );
  assert.equal(isSameDocumentUrl("not a URL", "file:///C:/Temp/portable/index.html"), false);
});
