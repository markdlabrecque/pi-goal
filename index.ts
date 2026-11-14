import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { decide, humanTool, progressKey } from "./policy.ts";
import {
  createGoal,
  formatStatus,
  goalInstructions,
  restoreGoal,
  STATE_TYPE,
  unfinished,
  validCriteria,
  type GoalState,
} from "./state.ts";
import { registerReportTool } from "./tools.ts";

const MESSAGE_TYPE = "pi-goal:instructions";
const HELP =
  "Usage: /goal <text> | start <text> | status | pause | resume | cancel | limit <positive integer> | criteria <JSON string array>";

export default function piGoal(pi: ExtensionAPI): void {
  let state: GoalState | undefined;
  let generation = 0;
  let cycleProgress = new Set<string>();
  const calls = new Map<
    string,
    { generation: number; name: string; args: unknown }
  >();
  let lastOutcome = "completed";

  function invalidate(): void {
    generation++;
    calls.clear();
    cycleProgress.clear();
  }
  function enableReportTool(): void {
    if (!pi.getAllTools().some((tool) => tool.name === "goal_report")) {
      throw new Error(
        "goal_report is unavailable. Include it in your tool allowlist before starting a goal.",
      );
    }
    const active = pi.getActiveTools();
    if (!active.includes("goal_report"))
      pi.setActiveTools([...active, "goal_report"]);
  }
  function show(ctx: ExtensionContext): void {
    if (ctx.hasUI)
      ctx.ui.setStatus(
        "pi-goal",
        state
          ? `Goal ${state.status} · ${state.continuations}/${state.maxContinuations}`
          : undefined,
      );
  }
  function feedback(
    ctx: ExtensionContext,
    text: string,
    warning = false,
  ): void {
    if (text.length > 12000)
      text =
        text.slice(0, 12000) +
        "\n[Truncated. Full evidence is in pi-goal session entries.]";
    if (ctx.hasUI) ctx.ui.notify(text, warning ? "warning" : "info");
    else
      pi.sendMessage(
        { customType: "pi-goal:status", content: text, display: true },
        { triggerTurn: false },
      );
  }
  // Persistence precedes in-memory changes, so a write error never arms pursuit.
  function save(next: GoalState, ctx: ExtensionContext): void {
    pi.appendEntry(STATE_TYPE, structuredClone(next));
    state = next;
    show(ctx);
  }
  function pause(ctx: ExtensionContext, reason: string): void {
    if (state?.status !== "active") return;
    const next = { ...state, status: "paused" as const, reason };
    invalidate();
    // Fail closed even if persistence fails. A restart also restores as paused.
    state = next;
    save(next, ctx);
    feedback(ctx, `Goal paused: ${reason}`, true);
  }
  function restore(ctx: ExtensionContext): void {
    invalidate();
    state = undefined;
    lastOutcome = "completed";
    try {
      const restored = restoreGoal(ctx.sessionManager.getBranch());
      if (restored) save(restored, ctx);
      else show(ctx);
    } catch (error) {
      show(ctx);
      feedback(ctx, String(error), true);
    }
  }
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => {
    invalidate();
    state = undefined;
  });

  registerReportTool(
    pi,
    () => state,
    (next, ctx) => {
      invalidate();
      save(next, ctx);
    },
  );

  pi.registerCommand("goal", {
    description:
      "Start, inspect, pause, resume, or cancel a bounded session goal",
    getArgumentCompletions(prefix) {
      return [
        "start",
        "status",
        "pause",
        "resume",
        "cancel",
        "limit",
        "criteria",
      ]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      const text = args.trim();
      const [verb, ...rest] = text.split(/\s+/);
      const tail = rest.join(" ");
      if (!text || text === "status") {
        feedback(ctx, formatStatus(state));
        return;
      }
      if (text === "pause" || text === "cancel") {
        if (!unfinished(state)) {
          feedback(ctx, "No unfinished goal.", true);
          return;
        }
        invalidate();
        const next: GoalState = {
          ...state,
          status: text === "pause" ? "paused" : "cancelled",
          reason: `User requested ${text}.`,
        };
        state = next;
        save(next, ctx);
        feedback(
          ctx,
          `Goal ${next.status}. This disables goal continuations; it does not abort the current tool. Use Escape to stop current work.`,
        );
        return;
      }
      if (verb === "limit") {
        if (
          !unfinished(state) ||
          !/^[1-9]\d*$/.test(tail) ||
          !Number.isSafeInteger(Number(tail))
        ) {
          feedback(
            ctx,
            "Set /goal limit <positive safe integer> on an unfinished goal.",
            true,
          );
          return;
        }
        save({ ...state, maxContinuations: Number(tail) }, ctx);
        feedback(ctx, formatStatus(state));
        return;
      }
      if (verb === "criteria") {
        if (!unfinished(state) || !ctx.isIdle()) {
          feedback(
            ctx,
            "Set criteria only while Pi is idle, on an unfinished goal.",
            true,
          );
          return;
        }
        try {
          const criteria: unknown = JSON.parse(text.slice(verb.length).trim());
          if (!validCriteria(criteria))
            throw new Error(
              "Use 1-20 unique, nonblank strings, each at most 8000 characters.",
            );
          invalidate();
          save(
            {
              ...state,
              criteria: criteria.map((c) => c.trim()),
              reports: [],
              noProgressCycles: 0,
            },
            ctx,
          );
          feedback(ctx, formatStatus(state));
        } catch (error) {
          feedback(ctx, String(error), true);
        }
        return;
      }
      if (text === "resume") {
        if (state?.status !== "paused") {
          feedback(ctx, "Only a paused goal can resume.", true);
          return;
        }
        if (!ctx.isIdle()) {
          feedback(ctx, "Wait for Pi to stop before resuming the goal.", true);
          return;
        }
        if (state.continuations >= state.maxContinuations) {
          feedback(ctx, "Raise /goal limit before resuming.", true);
          return;
        }
        try {
          enableReportTool();
        } catch (error) {
          feedback(ctx, String(error), true);
          return;
        }
        invalidate();
        lastOutcome = "completed";
        save(
          {
            ...state,
            status: "active",
            reason: undefined,
            noProgressCycles: 0,
          },
          ctx,
        );
        try {
          pi.sendMessage(
            {
              customType: MESSAGE_TYPE,
              content: goalInstructions(state!),
              display: false,
            },
            { triggerTurn: true },
          );
        } catch (error) {
          pause(ctx, `Could not start work: ${String(error)}`);
        }
        return;
      }
      if (["status", "pause", "resume", "cancel"].includes(verb)) {
        feedback(ctx, HELP, true);
        return;
      }
      if (unfinished(state)) {
        feedback(
          ctx,
          "A goal already exists. Resume or cancel it before starting another.",
          true,
        );
        return;
      }
      if (!ctx.isIdle()) {
        feedback(ctx, "Wait for Pi to stop before starting a goal.", true);
        return;
      }
      try {
        const next = createGoal(verb === "start" ? text.slice(5).trim() : text);
        enableReportTool();
        invalidate();
        lastOutcome = "completed";
        save(next, ctx);
        pi.sendMessage(
          {
            customType: MESSAGE_TYPE,
            content: `Goal started: ${next.text}\nLimit: ${next.maxContinuations} automatic continuations.`,
            display: true,
          },
          { triggerTurn: true },
        );
      } catch (error) {
        pause(ctx, `Could not start work: ${String(error)}`);
        feedback(ctx, String(error), true);
      }
    },
  });

  pi.on("before_agent_start", () => {
    if (state?.status === "active")
      return {
        message: {
          customType: MESSAGE_TYPE,
          content: goalInstructions(state),
          display: false,
        },
      };
  });
  // Keep the current goal available across compaction and context-only continuations.
  // Old extension instructions must not revive a finished or cancelled goal.
  pi.on("context", (event) => {
    const messages = event.messages.filter(
      (message) =>
        !(message.role === "custom" && message.customType === MESSAGE_TYPE),
    );
    if (state?.status === "active")
      messages.push({
        role: "custom",
        customType: MESSAGE_TYPE,
        content: goalInstructions(state),
        display: false,
        timestamp: Date.now(),
      });
    return { messages };
  });
  pi.on("tool_execution_start", (event) => {
    if (state?.status === "active")
      calls.set(event.toolCallId, {
        generation,
        name: event.toolName,
        args: structuredClone(event.args),
      });
  });
  pi.on("tool_call", (event, ctx) => {
    if (state?.status !== "active") return;
    if (humanTool(event.toolName)) {
      pause(
        ctx,
        `Human input requested by ${event.toolName}. Use /goal resume after answering.`,
      );
      return;
    }
    calls.set(event.toolCallId, {
      generation,
      name: event.toolName,
      args: structuredClone(event.input),
    });
  });
  pi.on("ui_prompt_start", (_event, ctx) =>
    pause(
      ctx,
      "An extension requested human input. Use /goal resume after resolving it.",
    ),
  );
  pi.on("tool_execution_end", (event, ctx) => {
    const call = calls.get(event.toolCallId);
    calls.delete(event.toolCallId);
    if (!call || call.generation !== generation || state?.status !== "active")
      return;
    if (event.isError && event.durationMs === undefined) {
      pause(
        ctx,
        "A tool did not execute. Resolve the failure before resuming.",
      );
      return;
    }
    if (!event.isError) {
      const key = progressKey(call.name, call.args, event.result);
      if (key) cycleProgress.add(key);
    }
  });
  pi.on("agent_end", (event) => {
    for (const message of event.messages)
      if (message.role === "assistant") lastOutcome = message.stopReason;
  });
  pi.on("agent_before_settle", (event, ctx) => {
    const decision = decide(state, event.outcome, [...cycleProgress]);
    if (decision.action === "pause") {
      pause(ctx, decision.reason);
      return;
    }
    if (decision.action !== "continue") return;
    // No await: pause/cancel cannot interleave between this check and the decision.
    if (ctx.signal?.aborted) {
      pause(ctx, "Agent aborted. Use /goal resume to continue.");
      return;
    }
    const next = decision.state;
    cycleProgress.clear();
    save(next, ctx);
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message" as const,
          customType: MESSAGE_TYPE,
          content: `${goalInstructions(next)}\nThe previous run ended without a completion or blocked report. Take the next concrete action.`,
          display: false,
        },
      ],
      continue: true,
    };
  });
  pi.on("agent_settled", (event, ctx) => {
    if (event.aborted)
      pause(ctx, "Agent aborted. Use /goal resume to continue.");
    else if (lastOutcome === "error")
      pause(ctx, "Provider error. Resolve it before resuming.");
    cycleProgress.clear();
    calls.clear();
  });
}
