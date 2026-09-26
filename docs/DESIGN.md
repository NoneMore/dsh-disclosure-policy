# Design — structured progress primitive, bounded reminders

Design updated: 2026-09-26 (ADR-0007).

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
  Checkpoint long autonomous work: report done, next, and approach;
  then continue unless blocked.

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

DSH preserves `deferLoading`, but an explicitly deferred baseline tool remains deferred until a retained addition activates it. This plugin needs its control primitive available from the beginning of the turn. PTC mode also carries a generated SDK representation, so deferred native declaration is not a universal context saving.

The compact always-available schema is the safer trade. Dynamic registration would also emit tool-update history and disturb request-prefix stability for a saving that is only a few hundred schema bytes.

## Native and PTC presentation

### Native mode

`disclose_progress` is a top-level tool call. The call arguments are durable model-authored data and can be shown by generic tool presentation.

### PTC mode

Only `run_code` is directly callable. `disclose_progress` is a generated SDK binding and executes as a nested native dispatch.

Nested calls still reach this plugin's executor and post-execute hooks, so interval reset semantics are identical.

DSH's conversation tool UI projects PTC dispatch children and dispatches atomic calls through the normal tool-view slot. Thus a progress call can still be inspected under its parent `run_code` card. The nested result remains execution-local and is not duplicated into model context.

A future client plugin may give `disclose_progress` a dedicated visual treatment without changing the host protocol.

## State

Each active turn owns one record:

```ts
interface IntervalState {
  silence: {
    calls: number
    firstReminderAt: number | null
    delivered: number
  }
  activity: ActivityState
  step: number | null
  remindedStep: number | null
  pendingDisclosureStep: number | null
  disclosedStep: number | null
}
```

Lifecycle:

| Event/action | Effect |
|---|---|
| `turn/start` | create fresh interval/activity state |
| `assistant/message` | record `data.step`; detect only a structured direct `disclose_progress` tool-call block; prose is ignored |
| successful `disclose_progress` | reset reminder accounting; mark the whole current step as the checkpoint boundary; preserve activity |
| ordinary completed tool | update activity; top-level call also advances cadence |
| `turn/end` | discard turn-local state |

The use of `assistant/message` is identity/accounting plus structured tool-call detection, never prose interpretation. A direct progress attempt temporarily suppresses a same-step due reminder so success cannot race a stale notice; failure leaves the cadence overdue for the next step.

## Cadence

`countCompletedCall()` counts top-level ordinary calls. Nested ordinary calls return before incrementing cadence.

The first reminder is due at `reminderAfterCalls`. Later reminders are spaced by the same amount from the first delivered reminder, until `maxReminders` is spent.

A reminder itself never resets the interval. Only a successful progress-tool invocation does.

A downstream post-execute exception advances cadence but cannot carry `additionalContexts`, so it does not spend the reminder slot. The pending reminder can be attached at the next deliverable boundary.

## One reminder per model step

Counting calls alone is insufficient when one model step emits a large parallel fan-out. For example, 24 calls with cadence 8 can cross three periods before the model has seen even the first reminder.

The adapter therefore remembers the current `assistant/message.data.step` and the step that already received a reminder.

If another call in the same step is also overdue, the call count still advances, but the extra reminder is withheld and its budget slot is not spent. On a later model step, the next overdue reminder may be delivered immediately.

This preserves the intended feedback loop:

```text
many parallel calls
  -> one notice
model gets a chance to react
  -> later notice only if still needed
```

## Activity context

Activity is independent of cadence.

Every completed ordinary operation, including nested native calls, is classified from its structured tool name as `inspect`, `mutate`, `verify`, or `other`.

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
- In PTC mode progress is visually nested under `run_code` unless a client adds a dedicated surface.
