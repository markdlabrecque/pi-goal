import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  MAX_CRITERIA,
  MAX_TEXT,
  type GoalReport,
  type GoalState,
  validateReport,
} from "./state.ts";

export function registerReportTool(
  pi: ExtensionAPI,
  getState: () => GoalState | undefined,
  save: (state: GoalState, ctx: ExtensionContext) => void,
): void {
  pi.registerTool({
    name: "goal_report",
    label: "Goal report",
    description:
      "Finish or pause the active pi-goal. Completion needs concrete evidence for every saved acceptance criterion. A blocked report explains the required human input. Evidence is a model claim, not independently verified proof. Call alone, as the last action.",
    promptSnippet:
      "Report completion evidence or a blocker for the active pi-goal",
    parameters: Type.Object(
      {
        goalId: Type.String({ minLength: 1, maxLength: 100 }),
        outcome: Type.Union([
          Type.Literal("complete"),
          Type.Literal("blocked"),
        ]),
        summary: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
        criteria: Type.Array(
          Type.Object(
            {
              criterion: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
              evidence: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
            },
            { additionalProperties: false },
          ),
          { maxItems: MAX_CRITERIA },
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("Goal report cancelled.");
      const state = getState();
      if (!state) throw new Error("No active goal.");
      const report: GoalReport = {
        ...params,
        summary: params.summary.trim(),
        criteria: params.criteria.map((item) => ({
          ...item,
          evidence: item.evidence.trim(),
        })),
      };
      validateReport(state, report);
      const status = report.outcome === "complete" ? "completed" : "paused";
      const next: GoalState = {
        ...state,
        status,
        reason: report.summary,
        reports: [...state.reports, report].slice(-20),
      };
      save(next, ctx);
      return {
        content: [{ type: "text", text: `Goal ${status}: ${report.summary}` }],
        details: { report },
        terminate: true,
      };
    },
  });
}
