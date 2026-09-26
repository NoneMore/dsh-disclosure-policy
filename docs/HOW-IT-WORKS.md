# How dsh-disclosure-policy works

Current implementation walkthrough for ADR-0007.

## 1. Runtime surface

The plugin contributes:

| Capability | DSH seam |
|---|---|
| structured progress primitive | `ctx.tools.register(defineTool(...))` |
| turn lifecycle + model-step identity | `session/event` |
| cadence/activity observation + reminder delivery | `tools/post-execute` |

It registers no guard, no turn-stopping listener, and no system-prompt section.

## 2. Progress tool

The registered model-facing schema is intentionally small:

```ts
defineTool({
  name: 'disclose_progress',
  description: 'Checkpoint long autonomous work: report done, next, and approach; then continue unless blocked.',
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

The tool remains visible in native mode and becomes an SDK binding in PTC mode. DSH's tool conversation UI projects PTC dispatch children, so nested calls can still be inspected by the supervisor.

## 3. Turn-local state

A `WeakMap<Session, IntervalState>` is initialized only on `turn/start` and deleted on `turn/end`.

State contains:
- disclosure cadence/budget counters;
- the rolling activity window;
- current Assistant `step`;
- the step that already received a reminder;
- a direct progress attempt pending in the current step;
- the step whose progress call successfully executed.

`assistant/message` copies `event.data.step` and checks only structured `tool-call` blocks for the exact `disclose_progress` name. No visible prose or reasoning is parsed.

## 4. What resets the interval

Only a successful `disclose_progress` executor resets reminder accounting.

Assistant prose — including the historical four-line `Disclosure / Done / Next / Approach` shape — has no runtime effect.

The progress tool is excluded from both cadence and activity accounting. A successful checkpoint makes its whole Assistant step the boundary: native sibling calls and a PTC enclosing `run_code` settling later in that same step are not charged to the fresh interval. The next Assistant step starts ordinary counting.

## 5. Cadence

For ordinary tools, `tools/post-execute`:

1. awaits downstream policy;
2. classifies the completed operation into the activity window;
3. advances cadence only for top-level calls;
4. if a reminder is due and the current model step has not already received one, prepends one plugin-sourced notice to `additionalContexts`.

A downstream exception still advances activity/cadence but cannot spend a reminder slot because there is no returned decision to carry context.

## 6. Parallel-step bound

One Assistant response can dispatch many top-level calls in parallel. Call count alone can cross multiple cadence periods before any next model request exists.

The plugin therefore uses `assistant/message.data.step` as a delivery fence. Once one call in a model step carries a reminder, later overdue calls in that same step advance counters but do not spend another reminder slot.

After the next Assistant message changes `step`, an overdue reminder can be delivered immediately. If that committed message contains a direct progress call, same-step reminder delivery is held until the attempt resolves, preventing a stale notice from racing a successful checkpoint.

## 7. Activity hint

All ordinary completed operations, including nested calls, enter the rolling activity window.

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

## 9. PTC details

Under `mode: ptc`, only `run_code` is a direct model tool; other visible tools become generated SDK bindings. `disclose_progress` can therefore be nested.

Nested calls:
- do execute the progress tool's reset logic;
- do not advance cadence themselves;
- are visible as PTC subcalls in the conversation tool projection;
- do not inject a separate successful result into model history.

This is why the same primitive works without a native-only assumption.

## 10. Known limitations

- No reminder can interrupt one long-running tool.
- A model may ignore `disclose_progress`.
- Field quality is not judged.
- Tool schema context cost is non-zero.
- PTC progress appears nested unless a client plugin adds dedicated presentation.
- Hot reload starts accounting at the next `turn/start`; no history reconstruction is performed.

## 11. Relevant DSH contracts

Primary upstream contracts used by this design:

- `defineTool()` validates typed parameters and canonical output.
- tool schemas are model-visible; output declarations/executors are not.
- `tools/post-execute` can append `additionalContexts`.
- `ToolExecution.parent` identifies nested PTC dispatches.
- `assistant/message` is durable before that response's tool calls run.
- PTC mode exposes generated SDK bindings and the Web tool UI projects PTC dispatch children.

See [SOURCES.md](SOURCES.md) for the audited links and [ADR-0007](adr/0007-structured-progress-tool.md) for the design decision.
