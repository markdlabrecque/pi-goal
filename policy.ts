import { createHash } from "node:crypto";
import type { GoalState } from "./state.ts";

export type Decision =
  | { action: "none" }
  | { action: "pause"; reason: string }
  | { action: "continue"; state: GoalState };

export function decide(
  state: GoalState | undefined,
  outcome: string,
  progressKeys: readonly string[],
): Decision {
  if (state?.status !== "active") return { action: "none" };
  if (outcome !== "completed")
    return {
      action: "pause",
      reason: `Agent ended with ${outcome}. Use /goal resume after resolving it.`,
    };
  if (state.continuations >= state.maxContinuations)
    return {
      action: "pause",
      reason: "Continuation limit reached. Raise /goal limit before resuming.",
    };
  const fresh = progressKeys.filter((key) => !state.progressKeys.includes(key));
  const noProgressCycles = fresh.length ? 0 : state.noProgressCycles + 1;
  if (noProgressCycles >= 2)
    return {
      action: "pause",
      reason:
        "Two cycles produced no new change or test evidence. Inspect the work before resuming.",
    };
  return {
    action: "continue",
    state: {
      ...state,
      continuations: state.continuations + 1,
      noProgressCycles,
      progressKeys: [...new Set([...state.progressKeys, ...fresh])].slice(-256),
    },
  };
}

export function humanTool(name: string): boolean {
  return /(?:^|__)(?:AskAQuestion|FlagAHuman|request_secret)$/i.test(name);
}

/** A bounded heuristic, not a test oracle. Repeated identical tool activity does not reset the stall count. */
export function progressKey(
  name: string,
  args: unknown,
  result: unknown,
): string | undefined {
  const input = args as { command?: unknown } | undefined;
  const changesFile = name === "edit" || name === "write";
  const runsCheck =
    (name === "bash" || name === "powershell") &&
    typeof input?.command === "string" &&
    /\b(test|tests|pytest|vitest|jest|lint|typecheck|tsc|check|build|cargo|make)\b/.test(
      input.command,
    );
  if (!changesFile && !runsCheck) return undefined;
  return createHash("sha256")
    .update(JSON.stringify([name, args, result]))
    .digest("hex");
}
