# dsh-disclosure-policy

Experimental DeepSeek Harness host plugin for one supervision problem: long autonomous turns can keep doing useful work while giving the human too little actionable progress information.

The current design makes disclosure a **structured model action** instead of a special Assistant-text format:

```text
disclose_progress({
  done: "what was just done and the result/uncertainty",
  next: "the immediate next action",
  approach: "the concrete operation or verification"
})
```

A successful call opens a new disclosure interval. Ordinary Assistant prose never resets disclosure accounting, so a progress checkpoint can no longer accidentally become a terminal answer just because the provider returned `stop`.

Target baseline: **DeepSeek Harness 0.1.7-rc.1+ in the 0.1.x line**.

## Why a tool instead of four-line Assistant prose

The previous protocol asked the model to emit exactly four visible lines. That made one Assistant response carry two incompatible meanings: interim progress and a response that may legally end the turn. A real session reproduced the failure: the model intentionally sent only the disclosure, planned to continue in a supposed "next turn", and DSH correctly ended the current turn.

`disclose_progress` removes that ambiguity. Progress is a tool action; final prose remains final prose. No `agent/turn-stopping` repair or prose recognizer is needed by the runtime.

The legacy `hasVisibleText()` and `isModelDisclosure()` exports remain under `./policy` for compatibility, but the plugin no longer uses them.

## Context overhead

The redesign is intentionally **replacement, not accumulation**:

- no standing disclosure section is added to the system prompt;
- one compact tool description is added;
- the tool has only three required string fields: `done`, `next`, `approach`; its one-line description still names findings, phase/plan shifts, checks, blockers, and long work as useful checkpoint moments; the body rejects whitespace-only values without adding parameter-schema text;
- those fields have no per-parameter descriptions;
- successful tool output is canonical `null` and renders **no model-facing result text**, so the checkpoint is not echoed back into context;
- the checkpoint explicitly opts into parallel scheduling; DSH otherwise treats an unspecified concurrency classifier as an exclusive barrier;
- when work remains, the model is told to batch the checkpoint with the next work tool(s), avoiding a dedicated extra model step in the common case;
- reminders are one short sentence and contain no four-line template;
- the optional activity suffix is a single compact factual sentence.

Tests enforce size ceilings for the fixed model-facing declaration/reminder text and inspect the registered schema so accidental prompt growth fails CI.

`deferLoading` is deliberately not used. Eligibility is handled earlier by Agent-scoped registration: only an exact-native runtime root receives the tool at all, while PTC/both agents and runtime children receive no declaration or reminder listeners. Eligible native roots still get the same compact fixed schema.

## Runtime scope

The plugin is **native-root-only**:

- a top-level Agent whose effective tool presentation is exactly `native` receives `disclose_progress` plus cadence/activity listeners;
- an Agent presenting `ptc` or `both` receives none of this plugin's model-facing or accounting surface;
- a runtime child/subagent receives none of it, even when that child presents tools natively;
- a cold-resumed session marked as subagent lineage (`origin: subagent` or positive `delegationDepth`) also remains excluded even if it currently appears as a runtime root.

Eligibility is sampled after Agent setup and before the first queued input is released. Hot reload also installs onto already-live eligible roots.

The progress tool itself does not advance reminder cadence and does not enter the activity window.

## Reminder cadence

Each turn starts a disclosure interval. Completed **top-level non-disclosure** tool calls advance the interval. By default:

- the first reminder is due after **8** completed top-level calls;
- repeat spacing backs off to **16**, **32**, then **64** additional calls and stays capped at 64;
- there is **no total reminder limit**: a model that keeps working without a checkpoint continues to receive increasingly sparse reminders;
- one Assistant step can receive at most **one** reminder, even if a large parallel fan-out crosses several cadence periods.

A due reminder is attached through `tools/post-execute -> additionalContexts` and is seen on the next model step. It asks for a brief `disclose_progress` checkpoint and, when work remains, tells the model to batch it with the next work tool(s).

A successful `disclose_progress` call resets the previous interval's cadence anchor and backoff state. Recent activity is preserved. Top-level ordinary sibling calls from the same Assistant step are charged to the fresh interval regardless of whether they settle before or after the progress call, so batching a checkpoint with a large parallel fan-out does not create a free-work gap. Reminder delivery is still fenced to at most one notice per model step.

## Activity hint

The plugin keeps a bounded rolling window of recent tool operations for the eligible native root. Tool names are classified coarsely as:

- `inspect`
- `mutate`
- `verify`
- `other`

When a normal reminder is already due, the plugin may add one factual suffix if the recent window contains enough inspection/search operations and no classified mutation/verification operation. This is context, not a separate trigger and not a productivity judgment.

Shell/composite tools remain `other`; the plugin does not parse arbitrary command text.

## Configuration

| Option | Default | Meaning |
|---|---:|---|
| `reminderAfterCalls` | `8` | Top-level non-disclosure calls before the first reminder. `0` disables reminders. |
| `maxReminderIntervalCalls` | `64` | Maximum spacing between repeat reminders after exponential backoff. Does not limit total reminders. |
| `activityWindowSize` | `16` | Recent operations retained for the activity hint. `0` disables hints only. |
| `inspectionHintMinInspections` | `8` | Minimum inspection/search operations required for the hint. |

Example patch override:

```yaml
- id: disclosure-policy
  config:
    reminderAfterCalls: 12
    maxReminderIntervalCalls: 96
    activityWindowSize: 24
    inspectionHintMinInspections: 12
```

All values are validated as safe integers. When reminders are enabled, `maxReminderIntervalCalls` must be at least `reminderAfterCalls`. A positive activity window must be at least as large as the inspection minimum.

## What the plugin does not do

It does not deny tool calls, mutate TODO/task state, generate progress content on the model's behalf, inspect chain-of-thought, judge whether a checkpoint is truthful/useful, scan historical Session events, or steer at `agent/turn-stopping`.

The runtime only verifies that the model invoked the structured progress primitive with the required fields.

## Limitations

- **A single long tool call is still silent.** DSH can inject reminders only at tool/step boundaries.
- **The model can ignore reminders.** Disclosure remains best-effort.
- **Content quality is not scored.** Structurally valid but vague/false checkpoints still reset the interval.
- **Eligible native roots still pay a fixed declaration cost.** PTC/both agents and runtime children pay no disclosure-tool schema cost because the tool is not registered in their scope.
- **Hot reload does not reconstruct the current turn.** State begins again at the next observed `turn/start`.

## Install locally

From the directory containing the checkout:

```bash
dsh plugin --profile web add ./dsh-disclosure-policy
dsh --profile web --dump-config
dsh --profile web
```

Replace `web` with the desired profile.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

`src/` is authoritative and `lib/` is committed build output. CI verifies typecheck, build, tests, committed build output, and package contents on Node 22.19 and Node 24.

See:

- [ADR-0007](docs/adr/0007-structured-progress-tool.md) — why disclosure is now a tool primitive and how context overhead is bounded.
- [DESIGN.md](docs/DESIGN.md) — current state machine and reminder design.
- [HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) — implementation walkthrough.
- [SOURCES.md](docs/SOURCES.md) — DSH contract evidence.
