const test = require("node:test");
const assert = require("node:assert/strict");
const {
  WINDOW_METRICS,
  fitWindowBounds,
  requestedWindowRectangle,
} = require("../electron/window-bounds.cjs");

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };

test("new windows use the calm default size near the lower-right work area", () => {
  assert.deepEqual(fitWindowBounds(null, workArea), {
    x: 1348,
    y: 158,
    width: 544,
    height: 854,
  });
});

test("saved window size is restored without forcing an aspect ratio", () => {
  assert.deepEqual(fitWindowBounds({ x: 100, y: 80, width: 630, height: 780 }, workArea), {
    x: 100,
    y: 80,
    width: 630,
    height: 780,
  });
});

test("window size and position can fill but never exceed the work area", () => {
  assert.deepEqual(fitWindowBounds({ x: -500, y: 3000, width: 1200, height: 1400 }, workArea), {
    x: 0,
    y: 0,
    width: 1200,
    height: workArea.height,
  });
  assert.deepEqual(fitWindowBounds({ x: 40, y: 40, width: 200, height: 300 }, workArea), {
    x: 40,
    y: 40,
    width: WINDOW_METRICS.minWidth,
    height: WINDOW_METRICS.minHeight,
  });
});

test("legacy position-only data migrates to the default size", () => {
  assert.deepEqual(requestedWindowRectangle({ x: 120, y: 90 }), {
    x: 120,
    y: 90,
    width: WINDOW_METRICS.defaultWidth,
    height: WINDOW_METRICS.defaultHeight,
  });
  assert.deepEqual(fitWindowBounds({ x: 120, y: 90 }, workArea), {
    x: 120,
    y: 90,
    width: WINDOW_METRICS.defaultWidth,
    height: WINDOW_METRICS.defaultHeight,
  });
});

test("very small displays remain usable instead of producing inverted limits", () => {
  assert.deepEqual(fitWindowBounds(null, { x: -800, y: 0, width: 360, height: 600 }), {
    x: -800,
    y: 0,
    width: 360,
    height: 600,
  });
});
