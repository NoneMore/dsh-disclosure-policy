# dsh-disclosure-policy

Experimental DeepSeek Harness **host-only** plugin for one failure mode: during a long autonomous turn, the model works for a long time without saying anything the supervisor can act on.

The plugin supports the human's job during execution — **supervision** — rather than compelling the model:

- a **standing policy** tells the model to keep working autonomously and to disclose briefly when there is material new information;
- a **bounded soft reminder cadence** nudges the model again while a disclosure interval keeps producing tool calls, up to a fixed budget per interval;
- an **activity hint** can add objective context from a rolling window of recent tool operations, independently of disclosure boundaries.

Disclosure is model-authored and best-effort. The plugin never denies a tool call, never rewrites task state, and never forces another step. See [`docs/adr/0001-supervision-over-enforcement.md`](docs/adr/0001-supervision-over-enforcement.md), [`docs/adr/0003-model-authored-disclosure.md`](docs/adr/0003-model-authored-disclosure.md), and [`docs/adr/0004-bounded-repeat-reminders.md`](docs/adr/0004-bounded-repeat-reminders.md).

Target baseline: **DeepSeek Harness 0.1.7-rc.1**. This checkout ships prebuilt `lib/` JavaScript so it can be installed without compiling TypeScript first.

> v0.3.0 replaced the v0.2.x `dsh-todo-checkpoint-guard` policy. The package, the patch row, and the plugin id are now `dsh-disclosure-policy` / `disclosure-policy`; TODO freshness and tool-call denial are out of scope. The repository directory name is unchanged. v0.4.0 keeps that scope and replaces the one-shot reminder latch with a bounded cadence.

## What the standing policy says

One static system-prompt section is installed at order `10150` (after the first-party Web-surface guidance at `10100`, before the deployment persona suffix at `10200`). It asks the model to disclose **briefly** when there is material new information, especially after:

- confirming a finding;
- completing a meaningful phase;
- changing the settled plan or departing from a settled constraint;
- obtaining a verification result;
- encountering a blocker or material uncertainty; or
- preparing to enter a clearly long stretch of work.

A disclosure uses exactly four visible lines, with all three fields non-empty and in order:

```text
Disclosure:
Done: Checked the replay records; the reward-index difference is still unresolved.
Next: Confirm the reward-index mapping.
Approach: Compare the original reward indices with the replay selections.
```

The corresponding Chinese label set is `披露 / 已做 / 将做 / 做法`. Use one complete label set, with `:` or `：` separators, and concise field contents in any language. Send the structure directly: fenced or indented code blocks, quotations, extra prose, blank internal lines, mixed labels, and missing or empty fields do not qualify. The fences above illustrate the format; an actual disclosure must have no fence.

`Done` describes recent work and its result or remaining uncertainty; `Next` states the immediate intended action; `Approach` states concrete operations or verification. Include plan/constraint changes and anything worth intervention where relevant. No new conclusion is required. An opening disclosure may honestly say execution has not started, and a blocker may name a dependency being awaited plus a conditional follow-up.

No opening preamble is required. The model asks the user a question only when the execution brief does not let it continue, and it never exposes private chain-of-thought.

The section is static: it carries no live counters and no per-turn state, so it cannot invalidate the cached prompt prefix.

## What the soft reminders do

The runtime keeps one small state record per turn, containing disclosure accounting and a separate activity window:

```text
completed top-level calls since recognized structured disclosure
call count where the first reminder was delivered
reminders delivered in this interval
recent activity window: inspect / mutate / verify / other
```

Rules:

- `turn/start` initializes the record; `turn/end` discards it.
- A model-authored `assistant/message` whose entire visible text matches the four-line structure resets the call count, the first-reminder anchor, and the delivered count, opening a new disclosure interval while preserving the activity window. Text blocks are concatenated in order; reasoning and tool-call blocks are excluded. Surrounding whitespace is ignored. Ordinary prose, incomplete structures, tool results, and plugin-authored messages do not reset accounting. Repeating a complete disclosure still resets it.
- Each **completed top-level** tool call increments the call count, whether it succeeded, failed, was denied by another tool policy, or a downstream post-execute listener threw. If that exception prevents reminder delivery, the call still advances the cadence but does not spend a budget slot, so the reminder stays pending for the next deliverable boundary. Nested calls inside a composite tool (`exec.parent !== undefined`) do not count separately for cadence.
- Every completed tool operation, including nested native calls, is also classified from its structured tool name as `inspect`, `mutate`, `verify`, or `other`. Generic shells/composite transports are deliberately `other`; the plugin does not parse arbitrary shell text.
- The activity window retains the last `activityWindowSize` observed operations (default `16`), in post-execute observation order. Nested native operations and `other` operations each occupy a position, including the enclosing composite call when observed. Old operations leave when newer ones fill the window.
- When an ordinary reminder is due and the window contains at least `inspectionHintMinInspections` inspection/search operations (default `8`) and no operation classified as mutation/verification, the reminder adds an objective hint. It states the actual window size and inspection count, then asks which unresolved fact further investigation would settle. A partial window can qualify. `other` occupies space but neither counts as inspection nor directly vetoes the hint. An old edit/test ceases to suppress the hint once it leaves the window. This creates no extra cadence or budget.
- The first reminder is delivered on the call that reaches `reminderAfterCalls`; each later one is delivered `reminderAfterCalls` calls after that anchor, until `maxReminders` notices have been delivered for the interval. After the budget is spent no more notices are sent until recognized disclosure opens a new interval. Incomplete structures do not trigger an extra correction; the next normally due notice supplies the format.
- The plugin appends each notice as one plugin-sourced context through `tools/post-execute` → `additionalContexts`, delivered on the next model step.
- A parallel step crosses at most one cadence period, so it produces at most one reminder.
- The reminder never resets the call count, so it keeps measuring the whole interval.
- The notice is `createUserMessage` with `source: { kind: 'disclosure-policy', form: 'notice', summary }`, and it is prepended to whatever downstream post-execute decisions and contexts already exist.

The reminder asks for the same concise four-line structure. A qualifying activity window can insert the objective hint described above, and every later reminder also states that no complete structured disclosure has been observed in this disclosure interval. This does not claim that the model sent no ordinary text. It never states how many reminders remain, treats the activity fact as a progress judgment, threatens denial, requests user input, or asks for chain-of-thought.

## Mechanism mapping

| Purpose | Extension point |
|---|---|
| Static disclosure policy | `systemPrompt.section({ order: 10150 })` |
| Turn and structured-disclosure observation | `session/event` live projection |
| Count calls/activity and deliver the due reminder | `tools/post-execute` → `PostToolDecision.additionalContexts` |

## Configuration

| Option | Default | Meaning |
|---|---:|---|
| `reminderAfterCalls` | `8` | Completed top-level calls per cadence period: the first reminder lands on this call, and each later one this many calls after it. `0` disables runtime reminders while keeping the standing policy. |
| `maxReminders` | `3` | Reminder budget for one disclosure interval. `1` restores the historical one-shot cadence; `0` disables runtime reminders. |
| `activityWindowSize` | `16` | Recent tool operations retained for activity hints, including nested native calls and `other`. `0` disables hints alone. |
| `inspectionHintMinInspections` | `8` | Minimum inspection/search operations in the activity window. Independent of reminder cadence. |

All options must be safe integers. Cadence, budget, and window capacity must be non-negative; the inspection minimum must be positive and must not exceed a positive window capacity. Capacity `0` skips only that comparison and leaves ordinary reminders working. Invalid configuration is rejected.

There are no cadence tiers, exempt-tool list, fact-row mode, slow-tool threshold, prose-length threshold, or TODO settings.

A custom config row can look like:

```yaml
- id: disclosure-policy
  config:
    reminderAfterCalls: 12
    maxReminders: 2
    activityWindowSize: 24
    inspectionHintMinInspections: 12
```

DSH patch rows replace the `config` value rather than deep-merging it. Both config layers re-fill omitted options from the plugin's hard-coded defaults, so a partial override reverts unlisted options to the defaults rather than to the values in `cordis.patch.yml`.

## What this plugin deliberately does not do

It does not generate disclosure from runtime facts, judge whether model prose is informative, discover or validate the execution brief, monitor or enforce `todo_write` freshness, rewrite task state, register `ctx.tools.guard()`, steer from `agent/turn-stopping` or any `session/event` callback, infer semantic task progress from tool traffic, carry live state in the system prompt, add custom durable events, or ship a client component. The coarse tool-name activity classes only contextualize a model-authored disclosure request; they are not themselves a progress judgment.

Native task accounting stays separate from disclosure. Installing this plugin changes nothing about the `todo_write` contract.

## Install locally

Unzip, then run from the directory containing the checkout:

```bash
dsh plugin --profile web add ./dsh-disclosure-policy-0.4.0
dsh --profile web --dump-config
dsh --profile web
```

Replace `web` with your profile name if needed.

## Limitations

- **Best-effort by construction.** A model that ignores the standing policy and the whole reminder cadence can stay silent for the rest of a turn. That is the accepted cost of removing enforcement.
- **The budget is per disclosure interval, and intervals are turn-local.** `turn/end` discards the state, so a model that keeps opening fresh turns is not covered by the cadence; this is a documented limitation rather than a guarantee.
- **Structure is checked; content quality is not.** A one-word acknowledgement cannot reset the interval, but complete structures containing vague, repeated, or false prose still can. Useful unstructured prose does not reset it either. There is no semantic review, novelty test, or deduplication (ADR-0005).
- **Live projection, not history reconstruction.** Current DSH deprecates synchronous `Session.eventAt()`, `snapshotEvents()`, and `ownEvents()` and prohibits new production calls to them. On hot reload mid-turn, no state exists until the next observed `turn/start`, so accounting restarts at the next turn rather than scanning the log.
- **Boundaries, not interruptions.** Nothing in DSH can inject text while a single long tool call is running. The reminder can only be attached when a call settles, so it lands on the *next* model step.
- **Counting is a failsafe, not a semantic trigger.** `reminderAfterCalls` measures completed calls since recognized disclosure. The semantic obligation lives in the standing policy.
- **Activity shape is intentionally coarse.** Classification uses only the structured tool name. Shell commands and unknown/composite tools remain `other`, and the inspection-only suffix reports requested operation types rather than claiming that a file really changed or that a verification really proved anything.
- **The prompt service is optional.** The plugin hard-injects only `tools` and probes `ctx.get('systemPrompt')`. A deployment that installs a complete replacement system prompt may suppress the section; the reminder still works.
- **No custom durable event types.** Disclosure state is plugin-local, because out-of-tree durable-event compatibility has sharp edges; see [`docs/SOURCES.md`](docs/SOURCES.md).
- **Host-only.** No client bundle is shipped, so there is no UI surface for the disclosure counter.

## Verification of the current checkout

On 2026-09-26, build, typecheck, `npm test` (48 tests: 27 policy and 21 runtime), Node syntax checks, package inspection, and an isolated real Web-profile boot passed. The packed plugin loaded under DSH `0.1.7-rc.2`, its composed row contained both activity settings, and the profile listened successfully. A controlled live model turn or period of real-use tuning was not run. See [`docs/VERIFICATION.md`](docs/VERIFICATION.md) for commands and limits.

## Development

```bash
npm install
npm run build
npm test
```

The source of truth is `src/`; `lib/` is committed so the plugin can be installed directly from this checkout. `src/policy.ts` is pure and imports nothing from the host, so the complete behavior is testable without the DSH dependency graph; `src/index.ts` only binds those decisions to Cordis extension points.

## Research docs

- [`docs/SOURCES.md`](docs/SOURCES.md) — claim-by-claim source audit (official contracts, community evidence, external comparison).
- [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) — implementation walkthrough with installed-tree citations.
- [`docs/DESIGN.md`](docs/DESIGN.md) — the design of the single disclosure lane and why the v0.2 enforcement lanes were removed.
- [`docs/PRACTICES.md`](docs/PRACTICES.md) and [`docs/CODEX-PRACTICES.md`](docs/CODEX-PRACTICES.md) — DSH plugin/UX practices and the Codex comparison.
