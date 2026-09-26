# How dsh-disclosure-policy works

Current implementation walkthrough for ADR-0007.

## 1. Runtime surface

The plugin contributes:

| Capability | DSH seam |
|---|---|
| root/native eligibility | global `agent/created` + `ctx.agents.roots()` + effective `run_code` visibility |
| structured progress primitive | eligible `agent.ctx.tools.register(defineTool(...))` |
| turn lifecycle + model-step identity | eligible Agent-scoped `session/event` |
| cadence/activity observation + reminder delivery | eligible Agent-scoped `tools/post-execute` |

It registers no guard, no turn-stopping listener, and no system-prompt section. PTC/both Agents and runtime children receive none of the three Agent-scoped contributions.

## 2. Progress tool

The registered model-facing schema is intentionally small:

```ts
defineTool({
  name: 'disclose_progress',
  description: 'Brief update after findings, phase/plan shifts, checks, blockers, or long work: done, next, approach; batch with work.',
  parameters: {
    done: { type: 'string', required: true },
    next: { type: 'string', required: true },
    approach: { type: 'string', required: true },
  },
  output: {
    schema: { type: 'null' },
    render: () => [],
  },
  async execute(_args, exec) {
    // reset reminder accounting for exec.agent.session
    return null
  },
})
```

The arguments are the model-authored disclosure. The successful result contains no model-facing text, avoiding an echo into the next request.

The tool exists only in exact-native runtime roots. PTC/both Agents and runtime children do not receive a `disclose_progress` declaration or SDK binding.

## 3. Turn-local state

Each eligible Agent scope owns one turn-local `IntervalState`, initialized on its `turn/start` and cleared on `turn/end`.

State contains:
- disclosure cadence/backoff counters;
- the rolling activity window;
- current Assistant `step`;
- completed top-level ordinary calls observed in the current step;
- the step that already received a reminder;
- a direct progress attempt pending in the current step.

`assistant/message` copies `event.data.step` and checks only structured `tool-call` blocks for the exact `disclose_progress` name. No visible prose or reasoning is parsed.

## 4. What resets the interval

Only a successful `disclose_progress` executor resets reminder accounting.

Assistant prose — including the historical four-line `Disclosure / Done / Next / Approach` shape — has no runtime effect.

The progress tool itself is excluded from both cadence and activity accounting. Ordinary top-level siblings are not excluded: the adapter counts them throughout the Assistant step. When a checkpoint succeeds, any top-level siblings that already settled in that step are carried across the reset into the fresh interval, and siblings settling later keep advancing the same fresh counter. This is deliberately conservative and settlement-order-independent; a checkpoint batched with work cannot make that work disappear from cadence. Reminder delivery remains suppressed for the rest of the checkpoint step and may surface on a later step if the fresh interval is already overdue.

## 5. Cadence

For ordinary tools, `tools/post-execute`:

1. awaits downstream policy;
2. classifies the completed operation into the activity window;
3. advances cadence only for top-level calls;
4. if a reminder is due and the current model step has not already received one, prepends one plugin-sourced notice to `additionalContexts`.

A downstream exception still advances activity/cadence but cannot advance delivered/backoff state because there is no returned decision to carry context.

The first reminder uses `reminderAfterCalls`. Repeat intervals then double after each delivered reminder until `maxReminderIntervalCalls` is reached. With defaults the spacings are 8, 16, 32, 64, 64, ... calls. There is no total reminder cap; a successful `disclose_progress` resets the backoff to its initial interval.

## 6. Parallel-step bound

One Assistant response can dispatch many top-level calls in parallel. Call count alone can cross multiple cadence periods before any next model request exists.

The plugin therefore uses `assistant/message.data.step` as a delivery fence. Once one call in a model step carries a reminder, later overdue calls in that same step advance call counters but do not advance reminder/backoff state.

After the next Assistant message changes `step`, an overdue reminder can be delivered immediately. If that committed message contains a direct progress call, same-step reminder delivery is held until the attempt resolves, preventing a stale notice from racing a successful checkpoint.

## 7. Activity hint

All ordinary completed operations observed for the eligible native root enter the rolling activity window.

Classification uses only the structured tool name. Generic shell/composite tools are `other`.

When a normal reminder is due, the plugin may append:

```text
Recent window: N/M inspection/search, 0 mutation/verification by tool-name classification.
If investigating further, name the unresolved fact.
```

This suffix is conditional. It creates no extra reminder and makes no productivity judgment.

## 8. Context-cost properties

There are four model-facing costs:

1. the fixed tool declaration;
2. the model's own progress-tool arguments when it chooses to report;
3. a short reminder only when cadence is due;
4. an optional short activity suffix.

There is **no** standing disclosure prompt and no successful result echo.

CI tests cap the fixed description/reminder sizes, inspect the schema for accidental parameter descriptions, and assert that successful rendering is empty.

## 9. Eligibility details

Eligibility combines live runtime ownership, durable subagent lineage, and the Agent's effective tool presentation.

- `ctx.agents.roots()` identifies live top-level Agents and excludes currently owned runtime children.
- `SessionHeader.origin === 'subagent'` or `delegationDepth > 0` excludes cold-resumed subagent sessions that no longer have a live parent owner. Generic `parentSession`/fork lineage is intentionally not enough.
- `agent.ctx.tools.get('run_code', agent)` is absent only for exact `native` presentation. Both `ptc` and `both` expose the reserved transport and are excluded.
- `agent/created` runs after Agent setup and before queued input is released, so preset/scoped presentation has already been composed when the plugin samples eligibility.
- Registrations are made through `agent.ctx`, so the tool and listeners are Agent-local and unwind when that Agent is disposed.

Eligibility is sampled at Agent creation, or when this plugin mounts over already-live roots. Mid-lifecycle presentation-mode mutation is not a supported transition for this plugin; reload or recreate the Agent after changing presentation.

## 10. Known limitations

- No reminder can interrupt one long-running tool.
- A model may ignore `disclose_progress`.
- Field quality is not judged.
- Eligible native roots still pay the compact tool-schema context cost.
- Hot reload starts accounting at the next observed `turn/start`; no in-flight interval is reconstructed.

## 11. Relevant DSH contracts

Primary upstream contracts used by this design:

- `defineTool()` validates typed parameters and canonical output.
- tool schemas are model-visible; output declarations/executors are not.
- `AgentRegistry.roots()` identifies current live ownership; durable `SessionHeader.origin` / `delegationDepth` separately preserve subagent lineage across cold resume.
- `agent/created` runs after setup; Agent-scoped registrations through `agent.ctx` exist only for that Agent and unwind on disposal.
- ToolRuntime's public `get(name, scope)` resolves the effective scoped view; reserved `run_code` is present for non-native presentation.
- Agent-scoped `session/event` and `tools/post-execute` listeners receive only that Agent's work.
- `assistant/message` is durable before that response's tool calls run.
- `tools/post-execute` can append `additionalContexts`.

See [SOURCES.md](SOURCES.md), [ADR-0007](adr/0007-structured-progress-tool.md), and [ADR-0008](adr/0008-native-root-only.md).
