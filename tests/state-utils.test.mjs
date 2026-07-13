import test from "node:test";
import assert from "node:assert/strict";
import { preferNewestState } from "../src/state-utils.js";

test("renderer state never moves to a lower revision", () => {
  const current = { revision: 8, runtime: { desktopHostError: null } };
  const older = { revision: 7, runtime: { desktopHostError: "stale" } };
  assert.equal(preferNewestState(current, older), current);
});

test("equal revisions still accept newer runtime information", () => {
  const current = { revision: 8, runtime: { desktopHostError: null } };
  const runtimeUpdate = { revision: 8, runtime: { desktopHostError: "window layer failed" } };
  assert.equal(preferNewestState(current, runtimeUpdate), runtimeUpdate);
});

test("initial and higher revisions are accepted", () => {
  const initial = { revision: 1 };
  const newer = { revision: 2 };
  assert.equal(preferNewestState(null, initial), initial);
  assert.equal(preferNewestState(initial, newer), newer);
});
