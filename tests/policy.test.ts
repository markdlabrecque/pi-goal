import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, humanTool, progressKey } from "../policy.ts";
import {
  createGoal,
  isGoalState,
  restoreGoal,
  STATE_TYPE,
  validateReport,
} from "../state.ts";

test("an incomplete active goal gets exactly one counted continuation", () => {
  const state = createGoal("Make tests pass");
  const result = decide(state, "completed", []);
  assert.equal(result.action, "continue");
  if (result.action === "continue") {
    assert.equal(result.state.continuations, 1);
    assert.equal(result.state.noProgressCycles, 1);
  }
  assert.equal(state.continuations, 0);
});

test("inactive goals never continue", () => {
  assert.equal(decide(undefined, "completed", []).action, "none");
  for (const status of ["paused", "completed", "cancelled"] as const) {
    assert.equal(
      decide({ ...createGoal("Goal"), status }, "completed", []).action,
      "none",
    );
  }
});

test("errors, aborts, and the lifetime continuation limit pause", () => {
  const state = createGoal("Goal");
  for (const outcome of ["error", "aborted"])
    assert.equal(decide(state, outcome, []).action, "pause");
  assert.equal(
    decide({ ...state, continuations: 10 }, "completed", ["fresh"]).action,
    "pause",
  );
});

test("two no-progress cycles pause; only fresh progress resets the count", () => {
  const key = progressKey("write", { path: "test.ts" }, { ok: true })!;
  const state = {
    ...createGoal("Goal"),
    noProgressCycles: 1,
    progressKeys: [key],
  };
  assert.equal(decide(state, "completed", [key]).action, "pause");
  const result = decide(state, "completed", ["new-key"]);
  assert.equal(result.action, "continue");
  if (result.action === "continue")
    assert.equal(result.state.noProgressCycles, 0);
  assert.equal(progressKey("read", {}, {}), undefined);
  assert.equal(progressKey("bash", { command: "ls" }, {}), undefined);
  assert.ok(progressKey("bash", { command: "npm test" }, { exitCode: 0 }));
});

test("completion requires exact coverage, evidence, active state, and the correct goal ID", () => {
  const state = { ...createGoal("Goal"), criteria: ["A", "B"] };
  const report = {
    goalId: state.id,
    outcome: "complete" as const,
    summary: "Done",
    criteria: [
      { criterion: "A", evidence: "passed" },
      { criterion: "B", evidence: "observed" },
    ],
  };
  validateReport(state, report);
  assert.throws(() =>
    validateReport(state, { ...report, criteria: report.criteria.slice(1) }),
  );
  assert.throws(() =>
    validateReport(state, {
      ...report,
      criteria: [{ criterion: "A", evidence: " " }],
    }),
  );
  assert.throws(() =>
    validateReport(state, {
      ...report,
      criteria: [report.criteria[0], report.criteria[0]],
    }),
  );
  assert.throws(() => validateReport(state, { ...report, goalId: "stale" }));
  assert.throws(() => validateReport({ ...state, status: "paused" }, report));
  validateReport(state, { ...report, outcome: "blocked", criteria: [] });
});

test("restoration uses only the current branch and always pauses unfinished goals", () => {
  const state = createGoal("Goal");
  const snapshot = { type: "custom", customType: STATE_TYPE, data: state };
  assert.equal(restoreGoal([snapshot])?.status, "paused");
  assert.equal(state.status, "active");
  assert.equal(restoreGoal([]), undefined);
  assert.equal(
    restoreGoal([
      snapshot,
      { ...snapshot, data: { ...state, status: "completed" } },
    ])?.status,
    "completed",
  );
  assert.throws(() =>
    restoreGoal([snapshot, { ...snapshot, data: { version: 2 } }]),
  );
  assert.ok(isGoalState(state));
  assert.equal(isGoalState({ ...state, maxContinuations: Infinity }), false);
});

test("human tools include namespaced forms, not unrelated names", () => {
  for (const name of ["AskAQuestion", "FlagAHuman", "mcp__t3__request_secret"])
    assert.ok(humanTool(name));
  assert.equal(humanTool("read"), false);
});
