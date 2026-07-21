const WINDOW_METRICS = Object.freeze({
  defaultWidth: 544,
  defaultHeight: 854,
  minWidth: 420,
  minHeight: 660,
  maxWidth: null,
  maxHeight: null,
  edgeGap: 28,
  topGap: 18,
});

function finiteInteger(value, fallback) {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(value, maximum));
}

function requestedWindowRectangle(savedBounds, metrics = WINDOW_METRICS) {
  const width = finiteInteger(savedBounds?.width, metrics.defaultWidth);
  const height = finiteInteger(savedBounds?.height, metrics.defaultHeight);
  return {
    x: finiteInteger(savedBounds?.x, 0),
    y: finiteInteger(savedBounds?.y, 0),
    width: width > 0 ? width : metrics.defaultWidth,
    height: height > 0 ? height : metrics.defaultHeight,
  };
}

function fitWindowBounds(savedBounds, workArea, metrics = WINDOW_METRICS) {
  if (!workArea
    || !Number.isFinite(workArea.x)
    || !Number.isFinite(workArea.y)
    || !Number.isFinite(workArea.width)
    || !Number.isFinite(workArea.height)
    || workArea.width <= 0
    || workArea.height <= 0) {
    throw new Error("Invalid display work area");
  }

  const area = {
    x: Math.trunc(workArea.x),
    y: Math.trunc(workArea.y),
    width: Math.max(1, Math.trunc(workArea.width)),
    height: Math.max(1, Math.trunc(workArea.height)),
  };
  const effectiveMaxWidth = Math.max(1, Math.min(Number.isFinite(metrics.maxWidth) ? metrics.maxWidth : area.width, area.width));
  const effectiveMaxHeight = Math.max(1, Math.min(Number.isFinite(metrics.maxHeight) ? metrics.maxHeight : area.height, area.height));
  const effectiveMinWidth = Math.min(metrics.minWidth, effectiveMaxWidth);
  const effectiveMinHeight = Math.min(metrics.minHeight, effectiveMaxHeight);
  const requested = requestedWindowRectangle(savedBounds, metrics);
  const width = clamp(requested.width, effectiveMinWidth, effectiveMaxWidth);
  const height = clamp(requested.height, effectiveMinHeight, effectiveMaxHeight);
  const maxX = area.x + area.width - width;
  const maxY = area.y + area.height - height;
  const fallbackX = maxX - metrics.edgeGap;
  const fallbackY = Math.max(area.y + metrics.topGap, maxY - metrics.edgeGap);
  const requestedX = Number.isFinite(savedBounds?.x) ? Math.trunc(savedBounds.x) : fallbackX;
  const requestedY = Number.isFinite(savedBounds?.y) ? Math.trunc(savedBounds.y) : fallbackY;

  return {
    x: clamp(requestedX, area.x, maxX),
    y: clamp(requestedY, area.y, maxY),
    width,
    height,
  };
}

module.exports = {
  WINDOW_METRICS,
  fitWindowBounds,
  requestedWindowRectangle,
};
