# Spec — `dsh-disclosure-policy` (v0.3.0)

Status: accepted design; implementation deferred.
Feature directory: `.scratch/disclosure-policy/`.
Supersedes the proposed runtime-derived disclosure design and, once implemented, the v0.2.x checkpoint policy.

## 1. Purpose

The caller gives the model an **execution brief**: a settled goal, boundary, design, constraints, and verification method sufficient for autonomous execution. During execution, the model discloses concise information so the supervisor can decide whether to intervene with a decision, background, a correction, a change of direction, or a stop.

The plugin supports that behavior without trying to understand the work or compel the model. Disclosure is model-authored and best-effort.

## 2. Standing policy

The plugin installs one static system-prompt section at order `10150`. It tells the model to proceed autonomously and disclose briefly when there is material new information, especially after:

- confirming a finding;
- completing a meaningful phase;
- changing the settled plan or departing from a settled constraint;
- obtaining a verification result;
- encountering a blocker or material uncertainty; or
- preparing to enter a clearly long stretch of work.

A useful disclosure answers only what is relevant:

1. What is now confirmed?
2. Did this change the settled plan or constraints?
3. What happens next, and is there anything worth the supervisor's intervention?

The model does not need an opening preamble. It asks the user a question only when it cannot continue from the execution brief. It never exposes private chain-of-thought.

## 3. Soft reminder

The runtime maintains one small state record per `(session, turn)`:

```text
completed top-level calls since visible model text
reminded in this silence interval?
```

Rules:

- `turn/start` initializes the state.
- Any `assistant/message` containing non-whitespace visible `text` resets the call count and opens a new silence interval. Reasoning blocks and plugin-authored messages do not reset it.
- Each completed top-level tool call increments the count, regardless of whether its result succeeded, failed, or was denied by another tool policy. Nested calls inside a composite tool do not count separately.
- When the count first reaches `reminderAfterCalls`, the plugin appends one plugin-sourced notice through `tools/post-execute` → `additionalContexts` for the next model step.
- A parallel step produces at most one reminder.
- The reminder does not reset the count. The plugin sends no further reminder until the model emits non-empty visible text.
- State is discarded at `turn/end`. Hot reload starts from subsequently observed events and does not scan session history.

The reminder asks the model to provide a one- or two-sentence disclosure covering the three questions in §2 before continuing a large amount of tool work. It contains no runtime fact row, threat of denial, request for user input, or chain-of-thought request.

## 4. Configuration

There is one behavioral option:

| Option | Default | Meaning |
|---|---:|---|
| `reminderAfterCalls` | `8` | Positive integer threshold. `0` disables runtime reminders while retaining the standing policy. |

There are no cadence tiers, exempt-tool list, facts-only mode, slow-tool threshold, prose-length threshold, or separate TODO settings.

## 5. Mechanism mapping

| Purpose | Extension point |
|---|---|
| Static disclosure policy | `systemPrompt.section({ order: 10150 })` |
| Turn and visible-text observation | `session/event` live projection |
| Count completed top-level calls and deliver one reminder | `tools/post-execute` → `PostToolDecision.additionalContexts` |

The notice uses `createUserMessage` with `source: { kind: 'plugin', plugin: 'disclosure-policy', form: 'notice', summary }`. It preserves downstream post-execute decisions and contexts.

## 6. Explicit non-goals

The plugin does not:

- generate disclosure from runtime facts;
- judge whether model prose is informative;
- discover or validate the execution brief;
- monitor or enforce `todo_write` freshness;
- rewrite task state;
- register `ctx.tools.guard()`;
- steer from `agent/turn-stopping` or any `session/event` callback;
- classify semantic runtime events such as errors, subagents, plan transitions, or slow tools;
- carry live state in the system prompt;
- add custom durable events, a client component, workspace metrics, or an experiment mode; or
- require an opening preamble or a mid-run user decision when execution can continue.

Native task accounting remains separate from disclosure. Installing this plugin neither changes nor replaces the `todo_write` contract.

## 7. Acceptance

Automated checks establish that:

- the standing policy contains the three concise disclosure questions and excludes chain-of-thought;
- non-empty visible model text resets the state while reasoning and plugin messages do not;
- the configured top-level-call threshold produces one next-step reminder;
- nested calls do not count, parallel results produce at most one notice, and a silent interval is reminded only once;
- `reminderAfterCalls: 0` disables reminders without removing the standing policy;
- post-execute composition preserves downstream decisions and contexts; and
- the plugin registers no guard, mutates no TODO state, and performs no turn-stop steering.

Before packaging, run the repository-required unit tests, Node syntax checks, typecheck when dependencies are installed, and a real-profile boot when available.

## 8. Packaging and documentation impact

Implementation will rename the package and patch row to `dsh-disclosure-policy`, set version `0.3.0`, and update runtime documentation and the changelog. The repository directory remains unchanged.

The current v0.2 source and runtime documentation remain descriptive of the installed implementation until that migration happens.

## 9. Provenance

The design relies on the source audit in `docs/SOURCES.md` and these research reports:

- `.scratch/research/codex-interaction-mechanics.md` — model-facing disclosure practices and the absence of runtime commentary enforcement;
- `.scratch/research/dsh-extension-points.md` — session events, tool-pipeline ordering, and next-step contexts; and
- `.scratch/research/prompt-cache-and-volatile-text.md` — why per-turn state belongs in appended context rather than a volatile prompt section.

ADR-0001 records the removal of coercive guards. ADR-0003 records the choice to keep disclosure model-authored and best-effort; it supersedes ADR-0002.
