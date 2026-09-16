# Design — one silence lane, no enforcement

Research snapshot: 2026-09-16. Supersedes the v0.2 two-lane freshness design.

## Goal

Keep a long DSH turn *legible to a supervisor* without turning the transcript into a tool-by-tool log, and without compelling the model.

The premise is a division of labour: the caller settles the goal, boundary, design, constraints, and verification method — the **execution brief** — and the human's job during execution is to observe and decide whether to intervene. The plugin's only job is to make silence unlikely to last: a standing obligation, plus one reminder when a silence interval gets long.

## The single lane

```text
EXECUTION BRIEF (caller-supplied, not inspected)
        |
        v
standing disclosure policy ......... systemPrompt.section(order 10150)
        |
        v
visible assistant/message text ...... opens a new silence interval
        |
        v
completed top-level tool calls ...... advance the interval
        |
        v
tools/post-execute .................. at most one reminder per interval
```

There is no second lane and no hard checkpoint. Native task accounting (`todo_write`) is a different concern owned by a different plugin; this one neither reads nor writes it.

## Event ordering used by the design

DSH commits `assistant/message` before dispatching the tool calls that message requested. The plugin observes the committed message through `session/event`, so visible text in a response and the tool calls of that same response compose cleanly:

```text
callsSinceVisibleText = 7
        |
model replies with text + tool-call in one response
        |
session/event: assistant/message with visible text
        |
interval reset (calls = 0, reminder re-armed)
        |
tools/post-execute for that call: count 1, no reminder
```

Conversely, a tool-only response advances the interval; when it reaches the threshold, the settling call carries the reminder.

## Reminder path

On the call that reaches `reminderAfterCalls`, the running `tools/post-execute` listener prepends one plugin-sourced user-role context to `additionalContexts`. The agent loop delivers it into the next-step inbox, so it becomes model-visible at the *next* step boundary and cannot alter the request already in flight.

The listener composes instead of replacing: it awaits `next()`, keeps whatever decision the downstream policy produced (`accept`, value-replacing `accept`, or `block`), and prepends its own context. This mirrors the shipped first-party `dsh-repeat-tool-reminder` and keeps the plugin compatible with result-transformers such as `dsh-spill-policy`.

## Why there is no guard

`ctx.tools.guard()` is a monotonic deny with no allow result. It is the right tool for a hard invariant, and the wrong tool for this one:

- denial corrects the model's *style*, which was never the failure; the failure is the supervisor's blindness, and a denial does not cure blindness — it only makes the model talk;
- a guard is enforcement, and ADR-0001 removes enforcement from this plugin entirely;
- the reminder still needs `tools/post-execute` to deliver text, so a guard would add a second mechanism with no new capability.

The plugin therefore registers exactly two extension points and nothing else. Its own test suite asserts that: one `session/event` listener, one `tools/post-execute` listener, zero guards, no `todo` listener, no steering.

## Why the policy text is static

The section carries no counters, no timestamps, and no per-turn state. The assembled system prompt is a `system`-role entry inside `messages`; a route that reads the latest `system` message (the in-history default) appends a full copy when the rendering changes, and every other route rewrites node 0 in place. Either way, volatile prompt text invalidates the cached prefix from an early token. `.scratch/research/prompt-cache-and-volatile-text.md` traces that path; the conclusion is that per-turn state belongs in appended context (`additionalContexts`), and standing obligations belong in a static section.

## State model

One mutable record per session, held in a `WeakMap` and discarded at `turn/end`:

```ts
interface SilenceState {
  calls: number     // completed top-level calls since it opened
  reminded: boolean // whether this interval already got its one reminder
}
```

`turn/start` replaces the record, which is also the only initialization point: a hot reload mid-turn starts accounting at the next `turn/start` rather than reconstructing history. `assistant/message` with non-whitespace visible text calls `resetSilence()`, which clears `calls` and re-arms `reminded` in place.

`countCompletedCall()` is the whole counting policy in one pure function: nested calls return immediately without touching the counter, `reminderAfterCalls <= 0` never reminds, and the `reminded` latch guarantees at most one notice per interval regardless of how many calls settle in parallel.

## What an uncooperative model costs

The plugin accepts that it may have no effect on a model that ignores both the standing policy and the reminder. In exchange the policy surface is small and auditable: two listeners, one threshold, one static prompt section, and no way to change what the model is allowed to do. ADR-0001 records that trade explicitly, and ADR-0002's runtime-derived disclosure design is superseded.

## Not in scope

Runtime fact rows, semantic event classification (errors, subagents, plan transitions, slow tools), prose-quality scoring, execution-brief discovery, TODO freshness, custom durable events, a client projection, and any mid-run user decision while execution can continue.
