# dsh-disclosure-policy

Experimental DeepSeek Harness **host-only** plugin for one failure mode: during a long autonomous turn, the model works for a long time without saying anything the supervisor can act on.

The plugin supports the human's job during execution — **supervision** — rather than compelling the model:

- a **standing policy** tells the model to keep working autonomously and to disclose briefly when there is material new information;
- a **bounded soft reminder cadence** nudges the model again while a silence interval keeps producing tool calls, up to a fixed budget per interval.

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

A useful disclosure answers only what is relevant:

1. What is now confirmed?
2. Did this change the settled plan or the settled constraints?
3. What happens next, and is there anything worth the supervisor's intervention?

No opening preamble is required. The model asks the user a question only when the execution brief does not let it continue, and it never exposes private chain-of-thought.

The section is static: it carries no live counters and no per-turn state, so it cannot invalidate the cached prompt prefix.

## What the soft reminders do

The runtime keeps one small state record per silence interval:

```text
completed top-level calls since visible model text
call count where the first reminder was delivered
reminders delivered in this interval
```

Rules:

- `turn/start` initializes the record; `turn/end` discards it.
- Any `assistant/message` containing non-whitespace visible `text` resets the call count, the first-reminder anchor, and the delivered count, opening a new silence interval. Reasoning blocks, tool results, and plugin-authored messages do not reset it.
- Each **completed top-level** tool call increments the count, whether it succeeded, failed, was denied by another tool policy, or a downstream post-execute listener threw. If that exception prevents reminder delivery, the call still advances the cadence but does not spend a budget slot, so the reminder stays pending for the next deliverable boundary. Nested calls inside a composite tool (`exec.parent !== undefined`) do not count separately.
- The first reminder is delivered on the call that reaches `reminderAfterCalls`; each later one is delivered `reminderAfterCalls` calls after that anchor, until `maxReminders` notices have been delivered for the interval. After the budget is spent the interval stays silent until visible model text opens a new one.
- The plugin appends each notice as one plugin-sourced context through `tools/post-execute` → `additionalContexts`, delivered on the next model step.
- A parallel step crosses at most one cadence period, so it produces at most one reminder.
- The reminder never resets the call count, so it keeps measuring the whole interval.
- The notice is `createUserMessage` with `source: { kind: 'disclosure-policy', form: 'notice', summary }`, and it is prepended to whatever downstream post-execute decisions and contexts already exist.

The reminder asks for one or two sentences covering the three questions above. The first reminder in an interval is the bare request; every later one appends one fixed sentence stating that this is a repeat reminder and that no visible disclosure has been sent in this stretch. It never states how many reminders remain, contains no runtime fact row, no threat of denial, no request for user input, and no chain-of-thought request.

## Mechanism mapping

| Purpose | Extension point |
|---|---|
| Static disclosure policy | `systemPrompt.section({ order: 10150 })` |
| Turn and visible-text observation | `session/event` live projection |
| Count completed top-level calls and deliver the due reminder | `tools/post-execute` → `PostToolDecision.additionalContexts` |

## Configuration

| Option | Default | Meaning |
|---|---:|---|
| `reminderAfterCalls` | `8` | Completed top-level calls per cadence period: the first reminder lands on this call, and each later one this many calls after it. `0` disables runtime reminders while keeping the standing policy. |
| `maxReminders` | `3` | Reminder budget for one silence interval. `1` restores the historical one-shot cadence; `0` disables runtime reminders. |

There are no cadence tiers, exempt-tool list, fact-row mode, slow-tool threshold, prose-length threshold, or TODO settings.

A custom config row can look like:

```yaml
- id: disclosure-policy
  config:
    reminderAfterCalls: 12
    maxReminders: 2
```

DSH patch rows replace the `config` value rather than deep-merging it. Both config layers re-fill omitted options from the plugin's hard-coded defaults, so a partial override reverts unlisted options to the defaults rather than to the values in `cordis.patch.yml`.

## What this plugin deliberately does not do

It does not generate disclosure from runtime facts, judge whether model prose is informative, discover or validate the execution brief, monitor or enforce `todo_write` freshness, rewrite task state, register `ctx.tools.guard()`, steer from `agent/turn-stopping` or any `session/event` callback, classify semantic runtime events, carry live state in the system prompt, add custom durable events, or ship a client component.

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
- **The budget is per silence interval, and intervals are turn-local.** `turn/end` discards the state, so a model that keeps opening fresh turns is not covered by the cadence; this is a documented limitation rather than a guarantee.
- **Visible text is the reset, not disclosure quality.** A one-word acknowledgement resets the interval exactly like a real disclosure. The repeat cadence raises the cost of staying silent, not of answering evasively; the runtime does not score semantics.
- **Live projection, not history reconstruction.** Current DSH deprecates synchronous `Session.eventAt()`, `snapshotEvents()`, and `ownEvents()` and prohibits new production calls to them. On hot reload mid-turn, no state exists until the next observed `turn/start`, so accounting restarts at the next turn rather than scanning the log.
- **Boundaries, not interruptions.** Nothing in DSH can inject text while a single long tool call is running. The reminder can only be attached when a call settles, so it lands on the *next* model step.
- **Counting is a failsafe, not a semantic trigger.** `reminderAfterCalls` is a crude silence measure. The semantic obligation lives in the standing policy.
- **The prompt service is optional.** The plugin hard-injects only `tools` and probes `ctx.get('systemPrompt')`. A deployment that installs a complete replacement system prompt may suppress the section; the reminder still works.
- **No custom durable event types.** Silence state is plugin-local, because out-of-tree durable-event compatibility has sharp edges; see [`docs/SOURCES.md`](docs/SOURCES.md).
- **Host-only.** No client bundle is shipped, so there is no UI surface for the silence counter.

## Verification performed for this release

`npm run typecheck`, `npm test` (28 tests: 17 pure policy tests plus an 11-test fake-`ctx` runtime harness over the built `lib/`), Node syntax checks, package inspection, and an isolated real Web-profile boot were run in the release-review environment. The profile loaded the packed plugin and listened successfully; an end-to-end model turn that reaches the reminder threshold was not exercised. See [`docs/VERIFICATION.md`](docs/VERIFICATION.md) for exact commands and results.

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
- [`docs/DESIGN.md`](docs/DESIGN.md) — the design of the single silence lane and why the v0.2 enforcement lanes were removed.
- [`docs/PRACTICES.md`](docs/PRACTICES.md) and [`docs/CODEX-PRACTICES.md`](docs/CODEX-PRACTICES.md) — DSH plugin/UX practices and the Codex comparison.
