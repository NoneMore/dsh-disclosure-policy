# Design — two independent freshness lanes

Research snapshot: 2026-09-16.

## Goal

Keep long DSH turns both **accountable** and **interruptible to a human observer** without turning the transcript into tool-by-tool narration.

The plugin treats these as separate state channels:

```text
PLAN STATE                  HUMAN PROGRESS
(todo/write)                (visible assistant/message text)
     |                               |
     v                               v
TODO freshness                   communication freshness
6 soft / 10 hard                8 soft / 12 hard
     |                               |
     +----------- tool guard --------+
```

A fresh TODO list does not imply the user has been informed. A progress message does not imply the TODO list is truthful. Each lane resets independently: a `todo_write` never clears the communication budget, and new visible text never clears the TODO budget.

The counters are not *fully* independent. The guard returns as soon as either lane blocks, so while one lane is blocked the other lane's counter stops advancing too, and a denial reports every lane that is stale rather than only the first one found.

## Event ordering used by the design

DSH stores model output as `assistant/message`, then dispatches any tool calls from that model output. The plugin observes the committed Assistant message through `session/event` before its tool executions reach `ctx.tools.guard()`.

That enables the intended hard-checkpoint recovery:

```text
callsSinceProgress = 12
        |
model tries tool-only response
        |
ctx.tools.guard() denies the ordinary tool
        |
model receives policy failure/context
        |
next assistant/message:
  text: "Root cause is X; I am patching Y, then rerunning Z."
  tool-call: edit(...)
        |
session/event sees substantive visible text -> reset to 0
        |
edit(...) reaches guard -> allowed
```

No synthetic Assistant message is required.

## Soft reminder path

On the tool call that reaches a soft threshold, the plugin reserves a reminder. After that tool settles, `tools/post-execute` prepends one plugin-sourced user-role context to `additionalContexts` for the next model step.

This mirrors first-party DSH guard practice: the reminder is model-visible and logged, while the Assistant remains responsible for producing user-facing narration.

## Hard block path

`ctx.tools.guard()` is used for the hard invariant because it is monotonic. The block reason tells the model exactly which lane is stale. If both lanes are stale, both obligations are returned together.

`todo_write` is always reachable. The top-level PTC `run_code` transport does not count, while nested native dispatches do.

## Progress quality policy

`progressMinChars` is deliberately weak. Its only purpose is to keep tiny acknowledgements from resetting the runtime budget. A permanent system-prompt section carries the actual communication policy:

- report meaningful new information, not every command;
- mention important discoveries, phase completion, changed plans, verification outcomes, blockers, and next action;
- before another long tool stretch, tell the user what is about to happen and why;
- do not expose chain-of-thought.

The wording is inspired by Codex's public progress-update prompt, while the implementation stays native to DSH (`assistant/message`; no Codex `MessagePhase` clone).

## Turn-stop reconciliation

If a Turn is about to close while the latest observed TODO snapshot still contains unfinished items, the plugin invokes one `agent.steer()` from `agent/turn-stopping`. It latches `(session, turn)` so the hook cannot create an infinite stop loop.

It never automatically flips TODO statuses. A completed Turn means the model stopped requesting tools; it does not prove every task succeeded.

## Why no custom durable checkpoint event yet

It would be useful for a future client UI to render explicit `checkpoint/requested` and `checkpoint/reconciled` events. Current community/source analysis shows an out-of-tree durable-event compatibility constraint: unknown persisted third-party event names require careful ignorable semantics and may not be in the stock harness's generated known-event catalog. v0.2 therefore keeps its counters in plugin-local live projections and relies only on first-party durable event types.

## Suggested v0.3 direction

Keep fixed N-call thresholds as a safety net, then add value-based triggers from real events:

- TODO item/phase transition;
- a failed or newly passing verification step;
- a changed plan;
- a blocker or user decision point;
- entry into another expected long-latency tool stretch.

A client-only projection can then show stale counters and checkpoint state. Human controls should remain separate: **Observe**, **Ask aside**, **Steer**, **Approve**, **Stop**.
