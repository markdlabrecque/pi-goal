# pi-goal

Pursue one goal in a Pi session, with evidence reports and bounded automatic continuation. Requires Pi 1.5.2 or later with `agent_before_settle` support. Tested with Pi 1.5.2 and Node 22.23.2 and 24.20.0.

## Load and use

This folder is already in Pi's global extension discovery path. Run `/reload` in Pi, then:

```text
/goal Make the test suite pass without skipping tests
/goal status
```

The extension starts work immediately. If the agent ends a run without a completion or blocked report, it requests another run. The default allows 10 extra runs. Ordinary tool calls, Pi retries, and compaction retries do not consume this counter.

No settings change is needed. No goal starts automatically when the extension loads. If you use a tool allowlist, include `goal_report`. Starting or resuming a goal activates that tool without changing the rest of your active tools.

| Command                                             | Behavior                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| `/goal <text>`                                      | Start a goal if there is no unfinished goal and Pi is idle.            |
| `/goal start <text>`                                | Explicit start syntax, including text that matches a reserved command. |
| `/goal` or `/goal status`                           | Show the goal, criteria, state, counter, and latest evidence report.   |
| `/goal pause`                                       | Disable automatic goal continuations.                                  |
| `/goal resume`                                      | Start work on a paused goal. Pi must be idle.                          |
| `/goal cancel`                                      | Cancel the goal and permit a new one.                                  |
| `/goal limit 25`                                    | Change the lifetime limit of an unfinished goal. Does not resume it.   |
| `/goal criteria ["Tests pass", "No tests skipped"]` | Replace acceptance criteria while Pi is idle. Clears prior reports.    |

**Pause and cancel do not abort a current tool or Pi's ordinary tool loop. Press Escape to stop current work.** They stop this extension from adding more work. A user message does not implicitly resume a paused goal.

The goal text is initially the single acceptance criterion. Write the goal so success is observable. For separate criteria, pause the goal, wait for Pi to become idle, set the criteria, then resume:

```text
/goal pause
/goal criteria ["The full test suite passes", "No tests are skipped"]
/goal resume
```

Goal text and individual criteria have an 8000-character limit. A goal can have up to 20 unique criteria. The extension stores state and reports in the session file. Do not put secrets in goals or evidence.

## Completion and human input

The model calls `goal_report` with the active goal ID and one of two outcomes:

- `complete` requires nonblank evidence for every saved criterion, copied exactly. Missing, duplicated, renamed, or unknown criteria are rejected.
- `blocked` pauses the goal. Its summary must include the question, missing permission, credential setup, or other action the user needs to take. It can have an empty evidence list.

Reports from a different goal, reports on a paused goal, and aborted report calls are rejected. A valid report is a terminating tool result, so it can finish without an extra model call when called alone.

The report is a model claim, **not independent verification**. The first version does not run a separately configured verification command. The model is instructed to run appropriate checks and cite concrete evidence before reporting success.

The extension pauses on:

- Escape or another agent abort.
- A provider failure after Pi's own recovery handling.
- The lifetime continuation limit.
- Two consecutive cycles without new change or test evidence.
- `AskAQuestion`, `FlagAHuman`, or `request_secret`, including MCP-style namespaced forms.
- An extension UI prompt, such as a question or approval dialog.
- A tool that fails before execution, such as a blocked or invalid call.

Answering or dismissing a question does not resume the goal. Use `/goal resume` after resolving it. A plain-text question cannot be detected reliably. The goal instructions require the model to submit a blocked report with the question in its summary.

## Limits and persistence

Progress detection is a heuristic. Successful `edit` and `write` calls, and successful `bash` or `powershell` calls with check-related command words, count as evidence of activity. Repeated identical arguments and results do not count as fresh evidence. Reads, unrelated shell commands, and failed tools do not reset the no-progress counter. This does not prove that work moved toward the goal.

The continuation limit counts additional runs requested by pi-goal, not requests, tokens, seconds, or money. The first run and explicit user resumes do not increment it. Resume cannot bypass an exhausted lifetime limit. Raise the limit explicitly first. A single ordinary Pi tool loop can still run for a long time. Use Escape to stop it.

Snapshots use the `pi-goal:state` custom entry type. Restoration reads only the active branch. Reload, session resume, fork, clone, and tree navigation restore unfinished goals as paused. Completed and cancelled goals stay inactive. Compaction leaves the durable record in history, and the context hook supplies current goal instructions on each model request. Old goal instructions are removed from future model context when the goal is inactive.

The extension does not change permissions, bypass approvals, start subagents, or run work in a background service. It does not use a monetary budget.

## Development and verification

```sh
cd ~/.pi/agent/extensions/pi-goal
npm ci --ignore-scripts
npm run typecheck
npm test
```

The host supplies Pi and TypeBox at runtime. Local dependencies are for development and testing only. `package-lock.json` pins the test SDK to Pi 1.5.2.

Tests cover policy, evidence validation, stale reports and tool results, questions and aborts, persistence, branch navigation, reload, and manual compaction. The integration tests use Pi's actual file loader, extension runner, session manager, and agent loop with a scripted offline provider. They use temporary settings and credential paths, not your credentials or project files.

The failing-test smoke test creates a tiny fixture in a temporary directory. It runs the failing test through Pi's bash tool, fixes the module through Pi's write tool, reruns the test successfully, and submits a completion report. No network model call is used. These tests verify control flow, not how reliably a real model judges arbitrary goals.

The approved design is in [plan.html](plan.html). The portable copy is [plan.packed.html](plan.packed.html).
