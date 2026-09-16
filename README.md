# dsh-todo-checkpoint-guard

Experimental DeepSeek Harness plugin for two failure modes that show up in long autonomous turns:

1. **task accounting goes stale** — `todo_write` is created near the start, then not maintained until the end;
2. **human-facing progress goes silent** — DSH can render mid-turn Assistant messages, but a model may run many tools without producing a substantive visible update.

Target baseline: **DeepSeek Harness 0.1.5-rc.2**. This checkout ships prebuilt `lib/` JavaScript so it can be installed without compiling TypeScript first.

> Research snapshot: 2026-09-16. See [`docs/SOURCES.md`](docs/SOURCES.md) for the claim-by-claim source audit, [`docs/PRACTICES.md`](docs/PRACTICES.md) for DSH implementation/UX practices, and [`docs/CODEX-PRACTICES.md`](docs/CODEX-PRACTICES.md) for a deeper source-backed comparison of Codex commentary, planning, async interaction, final-answer, and control patterns.

## What v0.2.x adds

### Lane A — TODO freshness

After a live `todo/write` contains unfinished items:

- ordinary tool calls consume a TODO freshness budget;
- at `reminderAfterCalls` (default **6**) a model-facing reminder asks for a truthful whole-list reconciliation;
- after `blockAfterCalls` (default **10**), the next ordinary tool call is denied until `todo_write` runs;
- at `agent/turn-stopping`, unfinished items trigger at most one extra reconciliation step before the turn can close.

`todo_write` itself is never blocked. The plugin never silently marks a task complete.

### Lane B — communication freshness

At each turn start, the plugin independently tracks ordinary tool calls since the latest **substantive user-visible Assistant text**:

- at `progressReminderAfterCalls` (default **8**) it injects a soft progress checkpoint;
- after `progressBlockAfterCalls` (default **12**), the next ordinary tool call is denied until the model emits a substantive visible mid-turn update;
- by default, a permanent system-prompt section asks the model to report meaningful phase completion, discoveries, plan changes, verification results, blockers, and the next action — while avoiding empty “still working” chatter and chain-of-thought.

The runtime fallback uses `progressMinChars` (default **24 non-whitespace Unicode characters**) only as a crude anti-empty-status heuristic. It is **not** an information-quality score. The semantic obligation lives in the prompt policy.

DSH commits `assistant/message` before dispatching tool calls from that assistant message. Therefore a message can satisfy a hard communication checkpoint naturally by emitting concise visible text **and** its next tool call in the same model response; the visible text resets the budget before the tool reaches the guard.

### PTC / Code Mode

Top-level `run_code` is exempt, while nested native tool calls underneath it count. This prevents a single transport call from hiding a large amount of real work. `todo_write` remains reachable even when the communication lane is blocked; however, updating TODO state does not reset the communication budget because task accounting and human narration are intentionally separate lanes.

## Why this uses native mid-turn Assistant messages

The plugin does **not** synthesize Assistant chat bubbles. DSH already treats `assistant/message` as a durable surface event, and the Web UI explicitly renders/folds earlier Assistant material inside an open/closed Turn. The guard only nudges or blocks until the **model itself** produces visible Assistant text. This keeps the normal transcript, provenance, UI folding, and steering behavior intact.

See `docs/DESIGN.md` for event ordering and recovery examples.

## Install locally

Unzip, then run from the directory containing the checkout:

```bash
dsh plugin --profile web add ./dsh-todo-checkpoint-guard-0.2.1
dsh --profile web --dump-config
dsh --profile web
```

Replace `web` with your profile name if needed.

A custom config row can look like:

```yaml
- id: todo-checkpoint-guard
  config:
    reminderAfterCalls: 8
    blockAfterCalls: 12
    progressReminderAfterCalls: 10
    progressBlockAfterCalls: 16
    progressMinChars: 24
    installProgressPolicy: true
    reconcileOnTurnStop: true
    exemptTools:
      - session_search
```

DSH patch rows replace the `config` value rather than deep-merging it, so include every option you care about when overriding the row. Omitting an option does not preserve this package's value for it: both config layers re-fill every missing option from the plugin's hard-coded defaults, so a partial override silently reverts the rest to the defaults rather than to the values in `cordis.patch.yml`. A partial override can also trip a cross-field rule that the schema itself does not check — `reminderAfterCalls: 10` passes validation on its own, then fails inside `apply` with `blockAfterCalls must be greater than reminderAfterCalls` and mounts nothing.

## Configuration

| Option | Default | Meaning |
|---|---:|---|
| `reminderAfterCalls` | 6 | Soft TODO reminder threshold |
| `blockAfterCalls` | 10 | Hard TODO checkpoint threshold |
| `progressReminderAfterCalls` | 8 | Soft communication reminder threshold |
| `progressBlockAfterCalls` | 12 | Hard communication checkpoint threshold |
| `progressMinChars` | 24 | Fallback minimum visible-text length used to reset communication freshness |
| `installProgressPolicy` | true | Add the Codex-inspired progress communication section when `ctx.systemPrompt` is available |
| `reconcileOnTurnStop` | true | Allow one bounded TODO reconciliation continuation at turn close |
| `exemptTools` | `[]` | Native tool names that consume neither budget |

The prompt service is optional by design: the plugin hard-injects only `tools` and probes `ctx.get('systemPrompt')`. If a deployment uses a complete replacement system prompt, external sections may be suppressed by that deployment; the runtime guard still works.

## Important limitations

- **Live projection, not history reconstruction.** Current DSH deprecates synchronous `Session.eventAt()`, `snapshotEvents()`, and `ownEvents()` and prohibits new production calls to them. That is a policy prohibition rather than a removed or type-marked API: all three are still public in `0.1.5-rc.2` and `dsh-session` still calls them internally. On HMR/hot-load mid-turn, communication tracking restarts from the next observed `assistant/message` (substantive or not), and TODO tracking restarts from the next observed `todo/write`. The one-turn reconciliation latch is plugin-local as well, so a hot reload can let the stop-boundary steer fire a second time in the same turn.
- **Text length is only a fallback heuristic.** A 24-character low-value sentence may still pass. The permanent prompt plus soft reminder is what tries to make updates informative.
- **Fixed call counts are failsafes, not ideal semantic triggers.** A future version can score meaningful phase transitions, test outcomes, plan changes, or blockers instead of relying mainly on N-call staleness.
- **Steer is best-effort at step boundaries.** The one turn-stop steer is intentionally at the documented lifecycle boundary. Do not copy it into a synchronous `session/event` listener; current Session append rejects re-entrancy.
- **No custom durable event types.** v0.2 keeps checkpoint state plugin-local because out-of-tree durable-event compatibility has sharp edges; see `docs/SOURCES.md`.
- **Host-only.** No client bundle is shipped yet. A later UI plugin could expose “calls since TODO update / calls since progress update” without changing the host policy.

## Verification performed for this zip

The generation environment ran the pure policy tests, Node syntax checks, JSON/YAML sanity checks, and archive validation. It did **not** boot an actual DSH 0.1.5-rc.2 Web profile because the full DSH npm dependency graph was not installed in this environment. Treat the first local DSH boot as the integration test; see `docs/VERIFICATION.md` for exact commands/results.

## Development

```bash
npm install
npm run build
npm test
```

The source of truth is `src/`; `lib/` is included for direct local installation. `docs/SOURCES.md` is intentionally part of the package so future edits can distinguish official contracts, community measurements, and external design inspiration. `docs/CODEX-PRACTICES.md` goes deeper on what is portable from Codex and what should *not* be copied blindly.
