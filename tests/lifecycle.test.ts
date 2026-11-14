import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import piGoal from "../index.ts";
import { STATE_TYPE, type GoalState } from "../state.ts";

function harness() {
  const handlers = new Map<string, Function[]>();
  let command: any;
  let report: any;
  const entries: any[] = [],
    messages: any[] = [],
    notices: string[] = [];
  let idle = true;
  const ctx = {
    hasUI: true,
    mode: "tui",
    isIdle: () => idle,
    ui: {
      setStatus() {},
      notify(text: string) {
        notices.push(text);
      },
    },
    sessionManager: { getBranch: () => entries },
  } as unknown as ExtensionContext;
  piGoal({
    on(name: string, fn: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerCommand(_name: string, def: any) {
      command = def;
    },
    registerTool(def: any) {
      report = def;
    },
    getActiveTools() {
      return ["read", "write", "bash"];
    },
    getAllTools() {
      return [{ name: "goal_report" }];
    },
    setActiveTools() {},
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data: structuredClone(data) });
    },
    sendMessage(message: unknown, options: unknown) {
      messages.push({ message, options });
    },
  } as unknown as ExtensionAPI);
  async function emit(name: string, event = {}) {
    let result: any;
    for (const fn of handlers.get(name) ?? [])
      result = (await fn(event, ctx)) ?? result;
    return result;
  }
  const state = () =>
    entries.filter((entry) => entry.customType === STATE_TYPE).at(-1)
      ?.data as GoalState;
  return {
    emit,
    state,
    entries,
    messages,
    notices,
    ctx,
    busy: () => {
      idle = false;
    },
    idle: () => {
      idle = true;
    },
    command: (args: string) => command.handler(args, ctx),
    report: (params: unknown, signal?: AbortSignal) =>
      report.execute("report", params, signal, undefined, ctx),
  };
}

test("settle preserves other entries, counts once, and pauses after two empty cycles", async () => {
  const h = harness();
  await h.command("Goal");
  const other = { type: "custom", customType: "other", data: {} };
  const result = await h.emit("agent_before_settle", {
    outcome: "completed",
    entries: [other],
  });
  assert.deepEqual(result.entries[0], other);
  assert.equal(result.continue, true);
  assert.equal(h.state().continuations, 1);
  assert.equal(
    await h.emit("agent_before_settle", { outcome: "completed", entries: [] }),
    undefined,
  );
  assert.equal(h.state().status, "paused");
});

test("abort at final settlement pauses without sending any new work", async () => {
  const h = harness();
  await h.command("Goal");
  const count = h.messages.length;
  await h.emit("agent_settled", { aborted: true });
  assert.equal(h.state().status, "paused");
  assert.equal(h.messages.length, count);
  await h.command("resume");
  assert.equal(h.state().status, "active");
  assert.equal(h.messages.length, count + 1);
});

test("questions, approvals, and FlagAHuman pause even if the question fails or is cancelled", async () => {
  for (const name of [
    "AskAQuestion",
    "FlagAHuman",
    "mcp__t3__request_secret",
  ]) {
    const h = harness();
    await h.command("Goal");
    await h.emit("tool_call", { toolName: name, toolCallId: "q", input: {} });
    await h.emit("tool_execution_end", {
      toolName: name,
      toolCallId: "q",
      isError: true,
    });
    assert.equal(h.state().status, "paused");
    assert.equal(
      await h.emit("agent_before_settle", {
        outcome: "completed",
        entries: [],
      }),
      undefined,
    );
  }
  const h = harness();
  await h.command("Goal");
  await h.emit("ui_prompt_start", { kind: "confirm" });
  await h.emit("ui_prompt_end", {});
  assert.equal(h.state().status, "paused");
});

test("cancel rejects stale tool results and reports; a busy session cannot resume", async () => {
  const h = harness();
  await h.command("Goal");
  const id = h.state().id;
  await h.emit("tool_call", {
    toolName: "write",
    toolCallId: "old",
    input: { path: "x" },
  });
  h.busy();
  await h.command("pause");
  await h.command("resume");
  assert.equal(h.state().status, "paused");
  await h.command("cancel");
  h.idle();
  await h.command("New goal");
  await h.emit("tool_execution_end", {
    toolName: "write",
    toolCallId: "old",
    isError: false,
    result: {},
  });
  await assert.rejects(
    h.report({
      goalId: id,
      outcome: "complete",
      summary: "Done",
      criteria: [],
    }),
  );
  await h.emit("agent_before_settle", { outcome: "completed", entries: [] });
  assert.equal(h.state().noProgressCycles, 1);
});

test("a complete report stops continuation, a blocked report pauses", async () => {
  for (const outcome of ["complete", "blocked"]) {
    const h = harness();
    await h.command("Goal");
    const result = await h.report({
      goalId: h.state().id,
      outcome,
      summary: "Result",
      criteria:
        outcome === "complete"
          ? [{ criterion: "Goal", evidence: "A passing check" }]
          : [],
    });
    assert.equal(result.terminate, true);
    assert.equal(
      h.state().status,
      outcome === "complete" ? "completed" : "paused",
    );
    assert.equal(
      await h.emit("agent_before_settle", {
        outcome: "completed",
        entries: [],
      }),
      undefined,
    );
  }
});

test("lifetime limits cannot be bypassed by resume", async () => {
  const h = harness();
  await h.command("Goal");
  await h.command("limit 1");
  await h.emit("agent_before_settle", { outcome: "completed", entries: [] });
  await h.emit("agent_before_settle", { outcome: "completed", entries: [] });
  await h.command("resume");
  assert.equal(h.state().status, "paused");
  await h.command("limit 2");
  await h.command("resume");
  assert.equal(h.state().status, "active");
});

test("criteria edits require idle and exact nonblank unique strings", async () => {
  const h = harness();
  await h.command("Goal");
  await h.command('criteria ["A", "B"]');
  assert.deepEqual(h.state().criteria, ["A", "B"]);
  await h.command('criteria ["A", " A "]');
  assert.deepEqual(h.state().criteria, ["A", "B"]);
  h.busy();
  await h.command('criteria ["C"]');
  assert.deepEqual(h.state().criteria, ["A", "B"]);
});

test("reload and tree navigation restore only paused state; compaction does not consume budget", async () => {
  const h = harness();
  await h.command("Goal");
  await h.emit("session_compact", {});
  assert.equal(h.state().continuations, 0);
  await h.emit("session_start", { reason: "reload" });
  assert.equal(h.state().status, "paused");
  await h.command("resume");
  await h.emit("session_tree", {});
  assert.equal(h.state().status, "paused");
  assert.equal(h.state().continuations, 0);
});

test("context removes obsolete instructions and keeps active goals available", async () => {
  const h = harness();
  await h.command("Goal");
  const old = {
    role: "custom",
    customType: "pi-goal:instructions",
    content: "stale",
  };
  const active = await h.emit("context", { messages: [old] });
  assert.equal(active.messages.length, 1);
  assert.match(active.messages[0].content, /Goal ID/);
  await h.command("cancel");
  assert.deepEqual((await h.emit("context", { messages: [old] })).messages, []);
});

test("provider failures pause; low-level retries do not consume goal budget", async () => {
  const h = harness();
  await h.command("Goal");
  await h.emit("agent_end", {
    messages: [{ role: "assistant", stopReason: "error" }],
  });
  await h.emit("agent_end", {
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  assert.equal(h.state().continuations, 0);
  await h.emit("agent_end", {
    messages: [{ role: "assistant", stopReason: "error" }],
  });
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.state().status, "paused");
});

test("start grammar preserves goal text and never replaces an unfinished goal", async () => {
  const h = harness();
  await h.command("start status");
  assert.equal(h.state().text, "status");
  const id = h.state().id;
  await h.command("Different goal");
  assert.equal(h.state().id, id);
  await h.command("pause");
  await h.command("Different goal");
  assert.equal(h.state().id, id);
  await h.command("cancel");
  await h.command("Different goal");
  assert.notEqual(h.state().id, id);
});

test("invalid and blocked preflight results pause before any continuation", async () => {
  const h = harness();
  await h.command("Goal");
  await h.emit("tool_execution_start", {
    toolName: "unknown",
    toolCallId: "bad",
    args: {},
  });
  await h.emit("tool_execution_end", {
    toolName: "unknown",
    toolCallId: "bad",
    isError: true,
  });
  assert.equal(h.state().status, "paused");
  assert.equal(
    await h.emit("agent_before_settle", { outcome: "completed", entries: [] }),
    undefined,
  );
});

test("aborted report calls cannot finish a goal", async () => {
  const h = harness();
  await h.command("Goal");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    h.report(
      {
        goalId: h.state().id,
        outcome: "complete",
        summary: "Done",
        criteria: [{ criterion: "Goal", evidence: "Passed" }],
      },
      controller.signal,
    ),
  );
  assert.equal(h.state().status, "active");
});

test("no-UI status gives feedback without triggering a model turn", async () => {
  const h = harness();
  Object.assign(h.ctx, { hasUI: false, mode: "json" });
  await h.command("status");
  assert.equal(h.messages[0].options.triggerTurn, false);
  await h.command("Goal");
  assert.equal(h.state().status, "active");
});

// These tests use Pi's real resource loader, extension runner, agent loop, and tools.
// All settings and credentials are isolated. The provider is a local script.
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type Context,
} from "@earendil-works/pi-ai";

async function realSession(
  t: TestContext,
  respond: (
    request: number,
    manager: SessionManager,
    context: Context,
  ) => AssistantMessage["content"] | "error",
  extra?: ExtensionFactory,
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-goal-"));
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  let session: AgentSession | undefined;
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error("Network is forbidden in pi-goal fixtures.");
  };
  t.after(async () => {
    session?.dispose();
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
    assert.equal(networkCalls, 0);
  });
  const manager = SessionManager.inMemory(dir);
  const errors: string[] = [];
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  let requests = 0;
  runtime.registerProvider("offline-goal", {
    api: "offline-goal",
    apiKey: "fixture",
    baseUrl: "offline://goal",
    models: [
      {
        id: "fixture",
        name: "Fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 1024,
      },
    ],
    streamSimple(model: Model<any>, context: Context) {
      const stream = createAssistantMessageEventStream();
      const response =
        ++requests > 20 ? "error" : respond(requests, manager, context);
      const content = response === "error" ? [] : response;
      const message: AssistantMessage = {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 10,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 20,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason:
          response === "error"
            ? "error"
            : content.some((item) => item.type === "toolCall")
              ? "toolUse"
              : "stop",
        ...(response === "error"
          ? { errorMessage: "Fixture provider failure" }
          : {}),
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        if (response === "error")
          stream.push({ type: "error", reason: "error", error: message });
        else
          stream.push({
            type: "done",
            reason: message.stopReason as "stop" | "toolUse",
            message,
          });
        stream.end();
      });
      return stream;
    },
  });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 512 },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  // Exercise file discovery through the manifest, not just an inline factory.
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: [new URL("../", import.meta.url).pathname],
    extensionFactories: extra ? [extra] : [],
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    systemPromptOverride: () => "Offline fixture.",
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await createAgentSession({
    cwd: dir,
    agentDir,
    modelRuntime: runtime,
    model: runtime.getModel("offline-goal", "fixture")!,
    settingsManager: settings,
    sessionManager: manager,
    resourceLoader: loader,
    tools: ["read", "write", "bash", "goal_report"],
  }));
  await session.bindExtensions({
    mode: "json",
    onError: (error) => errors.push(error.error),
  });
  return {
    session,
    manager,
    dir,
    errors,
    requests: () => requests,
    state: () => latest(manager),
  };
}
function latest(manager: SessionManager): GoalState {
  return (
    manager
      .getBranch()
      .filter(
        (entry) => entry.type === "custom" && entry.customType === STATE_TYPE,
      )
      .at(-1) as any
  )?.data;
}
function report(manager: SessionManager, outcome = "complete") {
  const state = latest(manager);
  return [
    {
      type: "toolCall" as const,
      id: "report-1",
      name: "goal_report",
      arguments: {
        goalId: state.id,
        outcome,
        summary:
          outcome === "complete" ? "Fixture tests pass" : "Need approval",
        criteria:
          outcome === "complete"
            ? state.criteria.map((criterion) => ({
                criterion,
                evidence: "node --test returned exit code 0",
              }))
            : [],
      },
    },
  ];
}

test("real Pi discovers pi-goal and pursues a failing-test fixture through completion", async (t) => {
  const h = await realSession(t, (request, manager) => {
    if (request === 1)
      return [
        {
          type: "toolCall",
          id: "test-failing",
          name: "bash",
          arguments: {
            command: "env -u NODE_TEST_CONTEXT node --test fixture.test.mjs",
          },
        },
      ];
    if (request === 2)
      return [{ type: "text", text: "The fixture fails; I will fix it next." }];
    if (request === 3)
      return [
        {
          type: "toolCall",
          id: "fix",
          name: "write",
          arguments: {
            path: "value.mjs",
            content: "export const value = 2;\n",
          },
        },
      ];
    if (request === 4)
      return [
        {
          type: "toolCall",
          id: "test-passing",
          name: "bash",
          arguments: {
            command: "env -u NODE_TEST_CONTEXT node --test fixture.test.mjs",
          },
        },
      ];
    return report(manager);
  });
  await writeFile(join(h.dir, "value.mjs"), "export const value = 1;\n");
  await writeFile(
    join(h.dir, "fixture.test.mjs"),
    'import assert from "node:assert/strict"; import { value } from "./value.mjs"; assert.equal(value, 2);\n',
  );
  await h.session.prompt("/goal Make the fixture tests pass");
  await h.session.waitForIdle();
  assert.equal(
    h.state().status,
    "completed",
    JSON.stringify(h.manager.getBranch().slice(-8), null, 2),
  );
  assert.equal(h.state().continuations, 1);
  assert.equal(h.requests(), 5);
  assert.match(await readFile(join(h.dir, "value.mjs"), "utf8"), /value = 2/);
  const results = h.manager
    .getBranch()
    .filter((e) => e.type === "message" && e.message.role === "toolResult")
    .map((e) => (e as any).message);
  assert.equal(
    results.find((r) => r.toolCallId === "test-failing")?.isError,
    true,
    JSON.stringify(results.find((r) => r.toolCallId === "test-failing")),
  );
  assert.equal(
    results.find((r) => r.toolCallId === "test-passing")?.isError,
    false,
  );
  assert.deepEqual(h.errors, []);
});

test("real Pi pauses a provider failure without an automatic goal restart", async (t) => {
  const h = await realSession(t, () => "error");
  await h.session.prompt("/goal Goal");
  await h.session.waitForIdle();
  assert.equal(h.state().status, "paused");
  assert.equal(h.requests(), 1);
  assert.deepEqual(h.errors, []);
});

test("real Pi does not restart after an abort during the settle hook", async (t) => {
  const h = await realSession(
    t,
    () => [{ type: "text", text: "Not finished" }],
    (pi) => {
      pi.on("agent_before_settle", (_event, ctx) => {
        ctx.abort();
      });
    },
  );
  await h.session.prompt("/goal Goal");
  await h.session.waitForIdle();
  assert.equal(h.state().status, "paused");
  assert.equal(h.requests(), 1);
  assert.deepEqual(h.errors, []);
});

test("real Pi stops on a blocked report and starts again only on explicit resume", async (t) => {
  const h = await realSession(t, (request, manager) =>
    report(manager, request === 1 ? "blocked" : "complete"),
  );
  await h.session.prompt("/goal Goal");
  await h.session.waitForIdle();
  assert.equal(h.state().status, "paused");
  assert.equal(h.requests(), 1);
  await h.session.prompt("/goal resume");
  await h.session.waitForIdle();
  assert.equal(h.state().status, "completed");
  assert.equal(h.requests(), 2);
  assert.deepEqual(h.errors, []);
});

test("real Pi reload restores an unfinished goal without starting work", async (t) => {
  const h = await realSession(t, (_request, manager) =>
    report(manager, "blocked"),
  );
  await h.session.prompt("/goal Goal");
  await h.session.waitForIdle();
  const id = h.state().id;
  await h.session.reload();
  assert.equal(h.state().id, id);
  assert.equal(h.state().status, "paused");
  assert.equal(h.requests(), 1);
  assert.deepEqual(h.errors, []);
});

test("real Pi tree navigation cannot import goal state from an abandoned branch", async (t) => {
  const h = await realSession(t, (_request, manager) =>
    report(manager, "blocked"),
  );
  const anchor = h.manager.appendCustomEntry("fixture:anchor", {});
  await h.session.prompt("/goal Old goal");
  await h.session.waitForIdle();
  const old = h.state();
  const oldEntry = h.manager
    .getBranch()
    .filter((e) => e.type === "custom" && e.customType === STATE_TYPE)
    .at(-1)!;
  await h.session.navigateTree(anchor);
  assert.equal(h.state(), undefined);
  await h.session.prompt("/goal New goal");
  await h.session.waitForIdle();
  assert.notEqual(h.state().id, old.id);
  await h.session.navigateTree(oldEntry.id);
  assert.equal(h.state().id, old.id);
  assert.equal(h.state().status, "paused");
  assert.equal(h.requests(), 2);
  assert.deepEqual(h.errors, []);
});

test("real Pi compaction retains goal instructions and does not spend continuations", async (t) => {
  const h = await realSession(
    t,
    (request, manager, context) => {
      if (request === 1) return report(manager, "blocked");
      assert.match(
        JSON.stringify(context.messages),
        /Saved acceptance criteria/,
      );
      return report(manager);
    },
    (pi) => {
      pi.on("session_before_compact", (event) => ({
        compaction: {
          summary: "Fixture summary",
          firstKeptEntryId: event.branchEntries.at(-1)!.id,
          tokensBefore: 100,
        },
      }));
    },
  );
  await h.session.prompt("/goal Goal");
  await h.session.waitForIdle();
  h.manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Fixture history. ".repeat(1000) }],
    timestamp: Date.now(),
  });
  h.manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Fixture history response." }],
    api: "offline-goal",
    provider: "offline-goal",
    model: "fixture",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 5000,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5005,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  await h.session.compact();
  await h.session.prompt("/goal resume");
  await h.session.waitForIdle();
  assert.equal(h.state().status, "completed");
  assert.equal(h.state().continuations, 0);
  assert.deepEqual(h.errors, []);
});
