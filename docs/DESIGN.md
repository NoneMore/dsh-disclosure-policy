# Design — structured progress primitive, bounded-rate reminders

Design updated: 2026-09-26 (ADR-0007, ADR-0009).

## Goal

Keep long DSH turns legible to a supervisor without turning progress into a terminal Assistant response and without adding a large permanent prompt tax.

The plugin has two responsibilities only:

1. expose a compact model-authored progress primitive;
2. nudge the model toward that primitive when a turn has gone too long without one.

It does not decide whether the work is good, truthful, complete, or blocked.

## Core protocol

```text
model work
   |
   +-- read/search/edit/test/run_code ...
   |
   +-- disclose_progress({ done, next, approach })
             |
             +-- supervisor can inspect structured call
             +-- reminder interval resets
             +-- recent activity window remains
             +-- normal agent tool loop continues
```

The important design boundary is:

> **Progress is a tool action. Final prose is final prose.**

No Assistant-text recognizer participates in runtime accounting.

## Why this replaces the old four-line protocol

The previous design treated a complete four-line Assistant message as disclosure. That was deterministic to recognize, but not deterministic in lifecycle semantics. A provider may return `stop` after any ordinary Assistant response, so the model could satisfy the disclosure request and accidentally end the turn before its own `Next` action.

A stop-boundary steer can patch that symptom, but it cannot make Assistant prose intrinsically non-terminal.

A tool call already has the correct lifecycle semantics: it is an action inside the agent loop. DSH executes it, records a result, and proceeds according to the normal tool loop. The progress primitive therefore removes the ambiguity rather than repairing it afterward.

## Model-facing surface and context budget

The model-facing surface is deliberately small:

```text
name: disclose_progress
description:
  Brief update after findings, phase/plan shifts, checks, blockers, or long work:
  done, next, approach; batch with work.

parameters:
  done: string
  next: string
  approach: string
```

There is no separate system-prompt section.

Parameter descriptions are omitted because the field names plus the one-line tool description are sufficient. The executor rejects whitespace-only fields before resetting accounting, so empty check-ins do not buy a fresh interval without expanding the schema. Successful canonical output is `null`; the Native renderer emits no content blocks. The tool therefore does not repeat the checkpoint back into the model's next request.

The ordinary reminder is likewise compact and names the tool rather than restating its schema.

The test suite enforces:
- a maximum description length;
- a maximum reminder/repeat length;
- a maximum serialized fixed tool declaration size;
- no parameter descriptions;
- empty successful result rendering;
- explicit `isConcurrencySafe: () => true`, because DSH otherwise schedules the checkpoint as exclusive;
- guidance to batch the checkpoint with the next work tool(s) when work remains.

These are regression guards against prompt creep.

### Why no `deferLoading`

Eligibility is handled by Agent-scoped registration rather than deferred loading. PTC/both Agents and runtime children never receive the tool, while an eligible native root receives the compact declaration immediately after its Agent setup and before queued input is released.

Using `deferLoading` inside an eligible root would solve a different problem: it would delay a tool that the policy wants available for proactive semantic checkpoints from the beginning of that Agent's work.

## Eligibility and Agent scope

The plugin does not register a global progress tool. It waits for Agent identity and installs into `agent.ctx` only when all conditions hold:

1. the live Agent is present in `ctx.agents.roots()`, so it is not currently runtime-owned by another Agent;
2. its durable header is not subagent lineage: `origin !== 'subagent'` and `delegationDepth` is absent or zero, covering cold-resumed children whose former parent is no longer live;
3. `agent.ctx.tools.get('run_code', agent)` is absent, which is the public ToolRuntime view of exact `native` presentation. `ptc` and `both` views contain the reserved `run_code` transport and are skipped.

`agent/created` is awaited after Agent setup and before queued input is released, so preset-owned presentation mode is already resolved when eligibility is sampled. The plugin also scans already-live roots on mount for hot-reload compatibility.

Eligible roots own `disclose_progress`, `session/event`, and `tools/post-execute` registrations through their Agent context. Scope-filtering therefore excludes every sibling Agent automatically and disposal unwinds the complete disclosure surface. PTC/both Agents and runtime children receive no tool declaration, SDK binding, counters, or reminder listener.


## State

Each active turn owns one record:

```ts
interface IntervalState {
  silence: {
    calls: number
    lastReminderAt: number | null
    delivered: number
  }
  activity: ActivityState
  step: number | null
  stepTopLevelCalls: number
  remindedStep: number | null
  pendingDisclosureStep: number | null
}
```

Lifecycle:

| Event/action | Effect |
|---|---|
| `turn/start` | create fresh interval/activity state |
| `assistant/message` | record `data.step`; reset the current-step top-level work counter; detect only a structured direct `disclose_progress` tool-call block; prose is ignored |
| successful `disclose_progress` | reset reminder accounting, then seed the fresh call count with top-level ordinary siblings already completed in the current step; preserve activity |
| ordinary completed tool | update activity; top-level call advances both the current-step work counter and cadence |
| `turn/end` | discard turn-local state |

The use of `assistant/message` is identity/accounting plus structured tool-call detection, never prose interpretation. A direct progress attempt temporarily suppresses a same-step due reminder so success cannot race a stale notice; failure leaves the cadence overdue for the next step.

Same-step work is not a checkpoint exemption. `stepTopLevelCalls` records completed top-level ordinary siblings for the current Assistant step. A successful checkpoint resets the old interval and seeds the fresh interval with that count; later top-level siblings in the same step continue incrementing it. This intentionally assigns all same-step sibling work to the fresh interval, independent of settlement order. The delivery fence still prevents another reminder in that same model step.

## Cadence

`countCompletedCall()` counts top-level ordinary calls. The pure helper retains its nested-call option for API compatibility, but the host policy is not installed in PTC/both scopes.

The first reminder is due at `reminderAfterCalls`. Each delivered repeat doubles the spacing from the previous delivered reminder until `maxReminderIntervalCalls` is reached; later repeats keep that capped spacing. With defaults, reminder carriers occur at cumulative call counts 8, 24, 56, 120, 184, 248, and so on.

There is no total reminder budget. The bound is on reminder **rate**, not reminder **count**, so an indefinitely silent model cannot permanently outwait the policy.

A reminder itself never resets the interval. Only a successful progress-tool invocation does.

A downstream post-execute exception advances cadence but cannot carry `additionalContexts`, so it does not advance the delivered/backoff state. The overdue reminder can be attached at the next deliverable boundary and the next backoff interval anchors from that actual delivery.

## One reminder per model step

Counting calls alone is insufficient when one model step emits a large parallel fan-out. For example, 24 calls with cadence 8 can cross three periods before the model has seen even the first reminder.

The adapter therefore remembers the current `assistant/message.data.step` and the step that already received a reminder.

If another call in the same step is also overdue, the call count still advances, but the extra reminder is withheld and the backoff state does not advance. On a later model step, the overdue reminder may be delivered immediately.

This preserves the intended feedback loop:

```text
many parallel calls
  -> one notice
model gets a chance to react
  -> later notice only if still needed
```

## Activity context

Activity is independent of cadence.

Every completed ordinary operation observed for the eligible native root is classified from its structured tool name as `inspect`, `mutate`, `verify`, or `other`.

`disclose_progress` is excluded from the activity window because it reports work rather than performing task work.

A reminder may gain one compact factual suffix when:
- the window contains at least `inspectionHintMinInspections` inspections;
- no classified mutation operation is present;
- no classified verification operation is present.

The suffix reports the observed counts only. It does not say that investigation is excessive or that a mutation/test truly happened.

## No stop steering and no guard

The current design registers no `agent/turn-stopping` listener and no `ctx.tools.guard()`.

A guard would enforce communication by denying task work. A stop steer would compensate for the old ambiguous Assistant-text protocol. Neither is necessary once progress is an explicit tool action.

## Legacy API compatibility

`hasVisibleText()`, `isModelDisclosure()`, and the historical prompt-order constants remain exported from `./policy` so existing importers do not fail immediately. They are compatibility helpers only and do not affect host-plugin behavior.

## Residual limits

- A model may ignore the tool and all reminders.
- The tool declaration has a fixed context cost; it is minimized, not zero.
- A single long blocking tool cannot be interrupted by this plugin.
- Structural fields can still contain unhelpful or false prose.
- Hot reload does not reconstruct an in-flight interval from history.
