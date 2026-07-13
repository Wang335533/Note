function isTrustedRendererEvent(event, expectedWebContents, isAllowedUrl) {
  if (!event || !expectedWebContents || typeof isAllowedUrl !== "function") return false;
  if (typeof expectedWebContents.isDestroyed === "function" && expectedWebContents.isDestroyed()) return false;
  if (event.sender !== expectedWebContents) return false;

  const frame = event.senderFrame;
  if (!frame) return false;

  try {
    if (frame.detached) return false;
    if (typeof frame.isDestroyed === "function" && frame.isDestroyed()) return false;
    if (frame.parent !== null) return false;
    return Boolean(isAllowedUrl(frame.url));
  } catch {
    return false;
  }
}

function isSameDocumentUrl(candidate, expected) {
  try {
    const actualUrl = new URL(candidate);
    const expectedUrl = new URL(expected);
    actualUrl.hash = "";
    actualUrl.search = "";
    expectedUrl.hash = "";
    expectedUrl.search = "";
    return actualUrl.href === expectedUrl.href;
  } catch {
    return false;
  }
}

module.exports = { isSameDocumentUrl, isTrustedRendererEvent };
