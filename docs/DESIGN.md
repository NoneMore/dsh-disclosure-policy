# Design — one disclosure lane, no enforcement

Design updated: 2026-09-26 (ADR-0005 and ADR-0006). Host-contract research snapshot: 2026-09-16. Supersedes the v0.2 two-lane freshness design.

## Goal

Keep a long DSH turn *legible to a supervisor* without turning the transcript into a tool-by-tool log, and without compelling the model.

The premise is a division of labour: the caller settles the goal, boundary, design, constraints, and verification method — the **execution brief** — and the human's job during execution is to observe and decide whether to intervene. The plugin's only job is to make long stretches without structured disclosure less likely: a standing obligation, plus a bounded reminder cadence while a disclosure interval stays long. The cadence is a nudge, not a guarantee: an interval that spends its whole budget receives no more reminders until structured disclosure.

## The single lane

```text
EXECUTION BRIEF (caller-supplied, not inspected)
        |
        v
standing disclosure policy ......... systemPrompt.section(order 10150)
        |
        v
structured model disclosure ......... opens a new disclosure interval
        |
        v
completed top-level tool calls ...... advance the disclosure interval
        |
        +---- all completed tools ..... update coarse activity shape
        |                              (nested native calls included)
        v
tools/post-execute .................. one reminder per cadence period,
                                     optionally with objective activity context,
                                     up to maxReminders per interval
```

There is still one reminder lane and no hard checkpoint: activity is context on that lane, not an independent trigger or budget. Native task accounting (`todo_write`) is a different concern owned by a different plugin; this one neither reads nor writes it.
## Structural recognition

Model-authored visible text is concatenated in content-block order, excluding reasoning and tool calls, and surrounding whitespace is trimmed. The complete text must be four lines: `Disclosure / Done / Next / Approach` or `披露 / 已做 / 将做 / 做法`, with `:` or `：` separators, an empty heading body, and three non-empty content fields. One label set must be used consistently and in order; fenced or indented code blocks, quotes, embedded examples, and extra prose do not qualify.

The model describes recent work and its result or uncertainty, the next intended action, and concrete operations or verification. Openings and blockers may state honest absence of past work or a dependency with conditional follow-up. The runtime verifies the expression contract only: repeated complete structures reset, malformed ones wait for the normal reminder, and neither usefulness nor truth is reviewed. Exported `SilenceState`, `createSilence()`, and `resetSilence()` keep their historical names for API compatibility; their state now measures a disclosure interval.

## Activity context: facts, not productivity judgments

The runtime keeps a second, ephemeral projection: a rolling window of recent operations within the
turn, preserved across disclosure boundaries (ADR-0006). Tool operations are classified from their
structured names as `inspect`, `mutate`, `verify`, or `other`. This projection has different accounting
from the reminder cadence:

- **cadence** counts completed top-level calls, because a composite tool is still one opportunity for
  the routed model to speak;
- **activity** counts nested native calls too, because otherwise one composite dispatch could hide a
  large inspection/search stretch;
- generic shells and composite transports remain `other`; the policy does not parse arbitrary
  command text or infer effects from it.

The configurable window retains `activityWindowSize` recent observations (default 16), in actual
post-execute observation order. All classified operations occupy a position, including `other`, nested
native calls, and their enclosing composite call when observed. Old edit/test operations stop suppressing
the hint once they leave the window. A partial window may qualify.

The activity projection does not create its own reminder schedule. When an ordinary reminder is due,
a window with at least `inspectionHintMinInspections` inspections (default 8) and no classified
mutation/verification operation gets one factual suffix. `other` neither counts toward that minimum nor
directly vetoes it. The suffix names the actual window size and inspection count and asks which
unresolved fact further investigation would settle; it makes no productivity judgment.

Both settings are independent of cadence and budget. They must be safe integers: capacity is
non-negative, the minimum positive, and the minimum cannot exceed a positive capacity. Capacity 0
disables hints alone and skips only that comparison. Every new turn starts empty; disclosure resets
only reminder accounting. There is no history reconstruction or new durable state.

This refines ADR-0003's distinction rather than replacing it: runtime facts may contextualize a request
for **model-authored disclosure**, but the plugin still does not present those facts as the disclosure
itself or synthesize a semantic progress report.

## Event ordering used by the design

DSH commits `assistant/message` before dispatching the tool calls that message requested. The plugin observes the committed message through `session/event`, so structured disclosure in a response and the tool calls of that same response compose cleanly:

```text
callsSinceDisclosure = 7
        |
model replies with structured disclosure + tool-call in one response
        |
session/event: assistant/message with structured disclosure
        |
interval reset (calls = 0, firstReminderAt = null, delivered = 0)
        |
tools/post-execute for that call: count 1, no reminder
```

Conversely, ordinary prose and tool-only responses leave the interval open; when it reaches a cadence period, the settling call carries that period's reminder.

## Reminder path

On the call that reaches `reminderAfterCalls`, and again on every call `reminderAfterCalls` further along until `maxReminders` notices have been delivered, the running `tools/post-execute` listener prepends one plugin-sourced user-role context to `additionalContexts`. The first notice is the bare request; each later one appends the same repeat sentence, which states that this is a repeat reminder and that no complete structured disclosure was observed in the interval — and never how many remain, because publishing the budget would let the model wait the cadence out (ADR-0004).

The agent loop delivers the notice into the next-step inbox, so it becomes model-visible at the *next* step boundary and cannot alter the request already in flight.

The listener composes instead of replacing: it awaits `next()`, keeps whatever decision the downstream policy produced (`accept`, value-replacing `accept`, or `block`), and prepends its own context. This mirrors the shipped first-party `dsh-repeat-tool-reminder` and keeps the plugin compatible with result-transformers such as `dsh-spill-policy`.

If `next()` throws, the completed top-level call still advances the interval and the exception still propagates. A boundary that throws cannot carry `additionalContexts`, so it consumes no budget slot: the cadence anchor stays unset and the pending reminder is attached to the next downstream decision that returns normally.

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
  calls: number                  // completed top-level calls since it opened
  firstReminderAt: number | null // call count where the first reminder was delivered
  delivered: number              // reminders delivered, and the budget index of the next
}
```

`turn/start` replaces the record, which is also the only initialization point: a hot reload mid-turn starts accounting at the next `turn/start` rather than reconstructing history. `assistant/message` accepted by `isModelDisclosure()` calls `resetSilence()`, which clears `calls`, the anchor, and the delivered count in place — the interval, not the individual reminder, is the unit that restores the budget.

`countCompletedCall()` is the whole counting policy in one pure function: nested calls return immediately without touching the counter, a non-positive threshold or budget never reminds, and the returned index is selected from the delivered count, which guarantees at most one notice per cadence period regardless of how many calls settle in parallel. `markReminderDelivered()` is deliberately separate, so only a boundary that actually attached `additionalContexts` spends a slot.

## What an uncooperative model costs

The plugin accepts that it may have no effect on a model that ignores both the standing policy and the whole reminder cadence. In exchange the policy surface is small and auditable: two listeners, four numeric options, one static prompt section, and no way to change what the model is allowed to do. ADR-0001 records that trade explicitly; ADR-0003's model-authored disclosure design still holds; ADR-0004 records why the reminder stopped being a one-shot.

Two limits are accepted rather than papered over. The budget is per interval and intervals are turn-local, so a model that keeps opening fresh turns is not covered. Only complete structured disclosure opens a new interval. Ordinary prose cannot reset it, but vague, repeated, or false complete structures still can; recognition does not score semantics (ADR-0005).

## Not in scope

Runtime fact rows, semantic event classification (errors, subagents, plan transitions, slow tools), prose-quality scoring, execution-brief discovery, TODO freshness, custom durable events, a client projection, and any mid-run user decision while execution can continue.
