# How `dsh-todo-checkpoint-guard` works

Runtime map of the plugin exactly as it exists in this checkout (package version **0.2.1**).

Every behavioral claim below is grounded in `src/`, the shipped `lib/`, the package metadata, the test
suite, or the installed DSH **0.1.5-rc.2** contracts. `README.md` and `docs/DESIGN.md` are treated as
*claims to check*, never as evidence — see
[Known gaps](#known-gaps--code-vs-prose-discrepancies).

Research snapshot: 2026-09-16.

> Environment note: this checkout has **no `node_modules/`**. The DSH contracts cited below were read
> from the installed harness at `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
> (aliased `DSHROOT/` in citations), which carries the exact versions this package peer-depends on.
> Anything not verifiable there is marked **unverified**.

---

## 1. Summary

The plugin is a Cordis **policy** plugin that watches one agent session and enforces two *independent*
freshness budgets over ordinary tool calls. **Lane A (TODO freshness)** exists only once a live
`todo/write` snapshot contains unfinished items; it reminds the model at 6 ordinary calls and denies
ordinary tools at 10 until a fresh `todo_write` runs. **Lane B (communication freshness)** is armed at
every `turn/start`; it reminds the model at 8 ordinary calls without substantive user-visible assistant
text and denies ordinary tools at 12 until the model emits such text itself. Both lanes share one
mechanism — a monotonic `ctx.tools.guard()` — and one soft-reminder channel —
`tools/post-execute.additionalContexts`. The plugin never writes assistant messages, never edits TODO
statuses, and never persists its own event types: all counters live in plugin-local `WeakMap`s keyed by
`Session`, rebuilt from the durable `session/event` firehose (`src/index.ts:112-277`).

| | Lane A — TODO | Lane B — communication |
|---|---|---|
| Armed by | a live `todo/write` with ≥1 non-`completed` item | every `turn/start` |
| Counts | ordinary tool calls since that write | ordinary tool calls since substantive visible text |
| Soft reminder | `reminderAfterCalls` = 6 | `progressReminderAfterCalls` = 8 |
| Hard denial | `blockAfterCalls` = 10 | `progressBlockAfterCalls` = 12 |
| Cleared by | a new `todo/write` (or all-completed list) | `assistant/message` with ≥24 non-whitespace chars |
| Extra closing step | `agent/turn-stopping` reconciliation | none |

---

## 2. Mount and registration

`package.json:30-34` declares the row source; nothing else in the package is a mount point:

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

`cordis.patch.yml:1-12` is a single **insert** patch — `{ insert: [ { id, name, config } ] }`. Per
`DSHROOT/dsh-app-boot/lib/index.js` (`applyEntryPatches`), an `insert` without a top-level `id` does
`data.push(...insert)`: it appends a brand-new row carrying its `config` object verbatim. It is not a
merge against anything.

| Export | Value | Source |
|---|---|---|
| `name` | `'todo-checkpoint-guard'` | `src/index.ts:25` |
| `inject` | `['tools']` | `src/index.ts:26` |
| `Config` | Schemastery object schema | `src/index.ts:47-56` |
| `apply` | `(ctx, rawConfig = {}) => void` | `src/index.ts:112` |

`inject: ['tools']` is a **hard** dependency. Cordis starts a plugin callback only "once the requested
dependencies are available" (`DSHROOT/cordis/lib/types/registry.d.ts:178-185`); a mount with no
`tools` service leaves the fiber pending rather than applying. `systemPrompt` is deliberately **not**
injected.

What `apply` registers and how it is disposed:

| Registration | Lifetime owner | Source |
|---|---|---|
| `ctx.on('session/event', …)` | fiber (Cordis `ctx.on` returns a disposer) | `src/index.ts:133` |
| `ctx.on('tools/post-execute', …)` | fiber | `src/index.ts:236` |
| `ctx.on('agent/turn-stopping', …)` | fiber, only if `reconcileOnTurnStop` | `src/index.ts:265` |
| `ctx.effect(() => ctx.tools.guard(…))` | explicit effect disposable | `src/index.ts:184` |
| `ctx.effect(() => systemPrompt.section({…}))` | explicit effect disposable, only if `installProgressPolicy` **and** probe succeeded | `src/index.ts:172-178` |

### The optional `systemPrompt` probe

```ts
const systemPrompt = ctx.get('systemPrompt')          // src/index.ts:170
if (systemPrompt !== undefined) {
  ctx.effect(() => systemPrompt.section({ name: 'plugin:todo-checkpoint-guard:progress-policy', order: 10150, text: PROGRESS_POLICY_TEXT }))
}
```

`ctx.get(name, strict = true)` reads a service "without the inject requirement" and returns
`undefined` when it is not (yet) provided (`DSHROOT/cordis/lib/types/reflect.d.ts:6-16`). Consequences:

- **No `systemPrompt` service → no prompt section, and no error.** The runtime guard path (sections
  5–7) works unchanged. This is the documented optional-service pattern.
- The probe happens **once**, at `apply` time. If `systemPrompt` is provided *later*, the section is
  never installed — there is no `ctx.inject`/reaction and no retry. A hot reload re-probes.
- `SystemPrompt.section()` throws on duplicate names within one layer and on non-finite orders, and its
  disposer unregisters the section (`DSHROOT/dsh-system-prompt/lib/types/index.d.ts:226-233`).

### Guard registration

```ts
ctx.effect(() => ctx.tools.guard((exec) => { … }))    // src/index.ts:184
```

`tools.guard(guard)` registers "a monotonic guard after the extensible `tools/pre-execute` waterfall…
Any matching guard may deny by returning a reason, while no guard can force-allow a call another guard
denied" (`DSHROOT/dsh-tools/lib/types/index.d.ts:611-620`; `ToolGuard` at `:482-489`). Registering on
the plugin's own (plain) context makes the guard **global**: it applies to every agent, so budgets are
per-session/per-agent and each subagent maintains its own.

---

## 3. Config

Two independent validation layers run, in this order.

**Layer 1 — Schemastery (`Config`, `src/index.ts:47-56`).** Cordis validates the row's `config` against
this schema and passes the validated value as `apply`'s second argument
(`DSHROOT/cordis/lib/types/registry.d.ts:193-198`).

| Option | Schema | Default |
|---|---|---|
| `reminderAfterCalls` | `z.number().step(1).min(1)` | `6` |
| `blockAfterCalls` | `z.number().step(1).min(2)` | `10` |
| `progressReminderAfterCalls` | `z.number().step(1).min(1)` | `8` |
| `progressBlockAfterCalls` | `z.number().step(1).min(2)` | `12` |
| `progressMinChars` | `z.number().step(1).min(1)` | `24` |
| `installProgressPolicy` | `z.boolean()` | `true` |
| `reconcileOnTurnStop` | `z.boolean()` | `true` |
| `exemptTools` | `z.array(z.string().min(1))` | `[]` |

Measured behavior of this layer (executed against Schemastery 3.18.2):

- every field is optional and **defaults are filled for missing *or* `null` keys**;
- `.step(1)` rejects `2.5` and `NaN`; `.min(1)` rejects `0` and negatives; wrong types are rejected;
- the object schema is **not strict** — unknown keys are accepted and preserved (`{ zzz: 1 }` passes through);
- **`reminderAfterCalls: 10, blockAfterCalls: 10` passes this layer** (only `blockAfterCalls >= 2` is checked);
- `exemptTools: ['  ']` passes this layer, because `min(1)` counts the two spaces.

**Layer 2 — `resolveConfig` (`src/policy.ts:55-98`), called first inside `apply`.**

| Check | Failure message |
|---|---|
| each of the five numbers is a positive safe integer | `todo-checkpoint-guard: <name> must be a positive safe integer` |
| `blockAfterCalls > reminderAfterCalls` | `todo-checkpoint-guard: blockAfterCalls must be greater than reminderAfterCalls` |
| `progressBlockAfterCalls > progressReminderAfterCalls` | `todo-checkpoint-guard: progressBlockAfterCalls must be greater than progressReminderAfterCalls` |
| `exemptTools`: `trim()` each entry, drop empties, `Set`-dedupe (first-occurrence order) | — |

`resolveConfig` returns a frozen object with a frozen `exemptTools` array. Both booleans are plain
`?? DEFAULT_CONFIG.x`, and `exemptTools: null` coalesces to `[]`.

Because Layer 2 runs before any registration, a config that passes Schemastery but violates an
ordering invariant (e.g. `10/10`) throws inside `apply` — that mount contributes **no** guard, no
listeners and no prompt section. `tests` assert exactly this (`test/policy.test.mjs:31-36`).

### The patch row's `config` replaces, it does not deep-merge

For a non-insert patch, `applyEntryPatches` applies `target[key] = value` per top-level key
(`DSHROOT/dsh-app-boot/lib/index.js`), so a `config:` block **replaces the whole config object**. In
practice the effect is weaker than that sounds: because Layer 1 fills every omitted key with the
*schema default*, an option you omit from an overriding row reverts to the hard-coded default, **not**
to the value written in `cordis.patch.yml`. The patch row's own values
(`reminderAfterCalls: 6 … exemptTools: []`) are byte-for-byte the defaults, so today the distinction is
unobservable — but "include every option you care about" is only about non-default values.

---

## 4. State model

All state is plugin-global and in-memory. Nothing is persisted and no custom durable event type is
defined.

| State | Scope | Type | Source |
|---|---|---|---|
| `todoStates` | per `Session` | `WeakMap<Session, { calls, epoch, todos }>` | `src/index.ts:58-65, 115` |
| `progressStates` | per `Session` | `WeakMap<Session, { calls, epoch, turn }>` | `src/index.ts:67-74, 116` |
| `reminders` | per `ToolExecution` | `WeakMap<ToolExecution, ReminderReservation>` | `src/index.ts:76-82, 117` |
| `reconciledTurns` | per `Session` | `WeakMap<Session, number>` | `src/index.ts:118` |
| `epoch` | plugin-global | `let epoch = 0` | `src/index.ts:119` |

Reset rules, all driven by the durable `session/event` firehose:

| Event | Effect |
|---|---|
| `turn/start` | `todoStates.delete(session)`; `progressStates = { calls: 0 }`; `reconciledTurns.delete(session)` (`:134-141`) |
| `turn/end` | delete both state objects (`:143-147`) |
| `todo/write` | `activateFromTodos` → new state with `calls: 0` **iff** the list has unfinished items, else delete (`:121-127, 149-152`) |
| `assistant/message` | substantive text → `progressStates = { calls: 0 }`; otherwise, **if no state exists at all**, also `{ calls: 0 }` (`:154-164`) |

Three fields are **write-only dead state**: `TodoFreshnessState.epoch`, `ProgressFreshnessState.epoch`
and `ProgressFreshnessState.turn` are assigned at `:126` and `:130` and never read anywhere. Staleness
is actually detected by **object identity** — `todoStates.get(session) === reservation.todoState`
(`:243, 247`) — because `resetProgress` and `activateFromTodos` always install a *fresh* object. A
reserved reminder whose lane was reset while the tool was running is therefore dropped, and
`post-execute` returns the downstream decision untouched (`:251`). The global `epoch` counter increments
on every reset and is never read; it is unbounded but harmless.

### What an HMR / hot-load mid-turn loses

`apply` runs from scratch: all four `WeakMap`s empty, `epoch` back to `0`, config re-resolved, old guard
and sections disposed and re-registered. Because `session/event` never replays history ("the
`session/event` firehose (constructor seeds do not emit)", `DSHROOT/dsh-session/lib/types/index.d.ts:126`),
a reload mid-turn means:

- **Lane A is inert** until the next observed `todo/write`. TODO enforcement does not resume from the
  previous snapshot.
- **Lane B is inert** until the next observed `assistant/message`. That message restarts the budget at
  `calls: 0` whether or not it is substantive — the `else if (!progressStates.has(session))` branch
  (`:160-163`) exists precisely for this case and is otherwise unreachable inside a turn, since
  `turn/start` always installs a state.
- **The `reconciledTurns` latch is lost**, so the `agent/turn-stopping` reconciliation can fire a
  *second* time for the same turn after a mid-turn reload.
- Any reminder reservation held in the old `reminders` map is discarded (no context is emitted).

---

## 5. Lane A — TODO freshness

**Arming.** `todo/write` carries the whole-list snapshot `{ todos: TodoItem[] }`, where `TodoItem` is
`{ content: string; status: 'pending' | 'in_progress' | 'completed' }`
(`DSHROOT/dsh-tool-todo/lib/types/types.d.ts:20-32`). `hasUnfinishedTodos` is
`todos.some(t => t.status !== 'completed')` (`src/policy.ts:100-102`) — deliberately conservative: an
unknown/future status counts as unfinished (asserted at `test/policy.test.mjs:43-48`). Only a live
`todo/write` with unfinished items creates `todoStates`; with no TODO list there is no Lane A at all.

**What increments / decrements.** Only the guard increments, and only for admitted ordinary calls:
`todoState.calls += 1` (`src/index.ts:213`). Nothing decrements — the counter is reset by replacing the
state object on the next `todo/write`, or by deleting it on `turn/start`/`turn/end`.

**Soft reminder path.** When the increment lands exactly on `reminderAfterCalls`
(`todoState.calls === config.reminderAfterCalls`, `:214`) the guard writes a `ReminderReservation` into
`reminders` keyed by the execution. The `tools/post-execute` waterfall listener (`:236-262`) awaits
`next()`, re-validates the reservation by object identity, and returns

```ts
{ ...downstream, additionalContexts: [notice(combinedReminderText(...)), ...downstream.additionalContexts] }
```

The notice is a plugin-sourced **user-role** message built with
`createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'Progress checkpoint' } })`
(`src/index.ts:84-96`). That shape is exactly `MessageSourceMap['plugin']` with the `notice` form and its
required 1-line `summary` (`DSHROOT/dsh-llm/lib/types/message.d.ts:82-101`); the summary is 19 chars,
inside `CONTEXT_SUMMARY_MAX_CHARS = 120` (`:110`). The registry composes
`[...result.additionalContexts ?? [], ...decisionContexts]` (`DSHROOT/dsh-tools/lib/index.js:3390`), and
the agent loop turns each entry into a next-step inbox item
(`DSHROOT/dsh-agent-loop/lib/index.js:578-579`). So the reminder is a **logged, durable, plugin-sourced
user-role context delivered on the next model step** — not an assistant bubble, not a synthetic human
message. The plugin itself never resets a budget from a reminder.

**Hard-block path.** At the top of the guard:

```ts
const todoBlocked = todoState !== undefined && todoState.calls >= config.blockAfterCalls   // :198
```

If `todoBlocked || progressBlocked` the guard **returns the denial reason string without
incrementing anything** (`:201-207`). A returned string is a monotonic denial
(`DSHROOT/dsh-tools/lib/types/index.d.ts:482-489`). The registry materializes it as a scheduled
`post-result` (`DSHROOT/dsh-tools/lib/index.js:3127-3139`) with

```js
content: [{ type: 'text', text: `Error: ${denialReason}` }], isError: true, error: { message: denialReason }
```

so the model sees one `isError` `tool/result` whose text is
`Error: ` + `todoBlockedReason(...)`. That reason is four sentences (`src/policy.ts:142-149`), ending
with `Do not batch-complete unfinished items just to pass the guard.` Because the denial is a
`post-result` rather than a `final-result`, `tools/post-execute` still runs for it — but no reservation
was made, so the plugin adds no context. The tool body never runs.

**Why `todo_write` stays reachable.** The guard returns before any counting or blocking for
`exec.name === 'todo_write'` (`src/index.ts:191`). `'todo_write'` is the real registered name
(`DSHROOT/dsh-tool-todo/lib/index.js:96`). Writing a TODO list repairs Lane A (the `todo/write` event
resets the counter) and **never touches Lane B**.

**Turn-stop reconciliation.** When `reconcileOnTurnStop` is true:

```ts
ctx.on('agent/turn-stopping', ({ agent, turn }) => {
  const state = todoStates.get(agent.session)
  if (state === undefined || !hasUnfinishedTodos(state.todos)) return
  if (reconciledTurns.get(agent.session) === turn) return
  reconciledTurns.set(agent.session, turn)
  agent.steer(notice(STOP_RECONCILE_TEXT))
})
```

`agent/turn-stopping` is a `serial`, awaited hook fired when "the turn is about to close… A listener that
objects steers (`agent.steer(...)`) and the machine re-reads its inbox: fresh steering runs another step,
none closes the turn" (`DSHROOT/dsh-agent/lib/types/runtime-types.d.ts:379-400`). The plugin uses it
**exactly** as documented and self-limits with the `(session, turn)` latch to **at most one** forced
continuation per turn. This is the one place the plugin calls `agent.steer`, and it is deliberately not
a `session/event` callback: `Session.append` throws `"session append cannot reenter while another append
is being published"` (`DSHROOT/dsh-session/lib/index.js:1181`). The steer is best-effort — if the inbox
is already drained the machine has decided, and steering can be discarded on cancellation. Note the
state it reconciles against is the **last observed snapshot**, and `turn/start` clears `todoStates`, so
this only fires for a turn in which a `todo/write` was actually observed.

---

## 6. Lane B — communication freshness

**What counts as substantive visible assistant text.** The plugin observes the durable
`assistant/message` event and passes its `message.content` through
`isMeaningfulVisibleAssistant(content, config.progressMinChars)`
(`src/index.ts:158`). `ContentBlock` is a merge-extensible union switched on `type`
(`DSHROOT/dsh-llm/lib/types/types.d.ts:91-102`); the helper keeps **only** `type === 'text'` blocks with
a string `text`, so `reasoning` and `tool-call` blocks never count. Each kept block is normalized with
`.replace(/\s+/gu, ' ').trim()`, empty results are dropped, the survivors are joined with `' '`, and the
length is `Array.from(normalized.replace(/\s/gu, '')).length` — i.e. **non-whitespace Unicode code
points**, counted after all whitespace is removed (`src/policy.ts:111-125`). `Array.from` means astral
characters count once, not twice.

**Ordering relative to tool dispatch.** This is the load-bearing fact for the whole design. In
`dsh-agent-loop`:

```js
live.settle('assistant/message', () => this.session.append('assistant/message', { turn, step, message, … }).seq)   // :1108
…
const toolCalls = message.content.filter(block => block.type === 'tool-call')                                       // :1116
if (toolCalls.length === 0) return { kind: 'completed' }
const { concluded } = await executeToolCalls(…)                                                                     // :1118
```

(`DSHROOT/dsh-agent-loop/lib/index.js:1108-1119`). And `Session.append` notifies observers
**synchronously**, inside the append, before returning:

```js
this.log.push(event); this.eventsSnapshot = void 0
if (callbacks !== undefined && entry !== undefined) invokeContainedSessionObservers(entry.emitCtx, 'session/event', entry.id, callbackArgs, callbacks)
```

(`DSHROOT/dsh-session/lib/index.js:1196-1203`; `invokeContainedSessionObservers` calls each callback
inline and only catches a *returned promise's* rejection asynchronously). Therefore the plugin's
`session/event` handler runs **before** `executeToolCalls`, and therefore before any guard for that
step's tools. See [section 9](#9-event-ordering--worked-timeline).

**Thresholds.** The counter increments alongside Lane A in the same guard, at
`progressState.calls === config.progressReminderAfterCalls` reserving a reminder (`src/index.ts:221-228`)
and at `progressState.calls >= config.progressBlockAfterCalls` denying (`:199`). The reminder text
(`progressReminderText`, `src/policy.ts:173-181`) and denial text (`progressBlockedReason`,
`:159-171`) both name the configured budget, and the denial restates `progressMinChars` as "a coarse
anti-empty-status heuristic, not a quality score".

**Lane B has no turn-stop step.** Turning the text obligation into a `steer` would make the plugin speak
for the model; instead the block plus the permanent prompt section push the *model* to emit the text.

**Why the lanes do not reset each other.** `todo/write` calls only `activateFromTodos`; it never touches
`progressStates` (`:149-152`). `assistant/message` calls only `resetProgress`; it never touches
`todoStates` (`:154-164`). A fresh TODO list therefore proves nothing about human-facing narration, and
a progress update proves nothing about TODO truthfulness — as intended. The **only** shared resets are
`turn/start` and `turn/end`, which clear both. See the caveat in
[section 10](#10-failure-and-edge-cases): the counters are independent but *coupled through the shared
blocking early-return*.

---

## 7. PTC / Code Mode

The exemption lives entirely in one pure predicate (`src/policy.ts:127-140`) called from the guard as
`shouldCountTool(exec.name, exec.parent !== undefined, exemptTools, RUN_CODE_NAME)`
(`src/index.ts:192`). `RUN_CODE_NAME` is imported from `@deepseek-ai/dsh-tools` and is `'run_code'`
(`DSHROOT/dsh-tools/lib/types/ptc.d.ts:13`; `lib/index.js:894`).

```ts
if (toolName === TODO_WRITE_NAME) return false
if (toolName === runCodeName && !hasParent) return false     // top-level transport call
if (exemptTools.has(toolName)) return false
return true
```

The exact rule: **a top-level `run_code` (`exec.parent === undefined`) consumes neither budget; every
nested sub-dispatch counts, including a nested `run_code`.** `parent` is the "opaque token of the
enclosing transport execution" which PTC mode sets on SDK sub-dispatches, and its presence is what
distinguishes a transport sub-dispatch from a model-direct call
(`DSHROOT/dsh-tools/lib/types/index.d.ts:209-218`). Nested dispatches are not a side channel: the PTC
driver runs them through the same ordered pipeline, `await scheduler.prepare(input)`
(`DSHROOT/dsh-tools/lib/types/ptc.js:437-448`), which is the stage containing `guardReason`
(`DSHROOT/dsh-tools/lib/index.js:3116-3127`).

The consequence is the one the README claims: a single `run_code` carrying a hundred sub-dispatches
looks like a hundred units of work to both freshness guards, so it cannot be used to hide a long tool
stretch behind one transport call.

---

## 8. System prompt section

When `installProgressPolicy` is true **and** `ctx.get('systemPrompt')` returned a service, the plugin
registers one static section (`src/index.ts:172-178`):

| Field | Value |
|---|---|
| `name` | `'plugin:todo-checkpoint-guard:progress-policy'` |
| `order` | `10150` |
| `text` | `PROGRESS_POLICY_TEXT` (`src/policy.ts:217-226`) |

`PromptSection` requires `name` (unique per layer), `order` (ascending; ties broken by code-unit name
order) and `text` (string or per-assembly provider); `complete` is not set, so this is an ordinary
additive section (`DSHROOT/dsh-system-prompt/lib/types/index.d.ts:46-68`). The order is deliberate: the
harness reserves `WEB_SURFACE: 10100` and `DEPLOYMENT_PERSONA_SUFFIX: 10200`
(`DSHROOT/dsh-system-prompt/lib/types/index.d.ts:138-141`), so `10150` lands **after** first-party
Web-surface guidance and **before** the deployment persona suffix.

`PROGRESS_POLICY_TEXT` is a `## Progress communication` block that instructs the model to send short
high-information mid-turn updates at meaningful phases, discoveries, plan changes, verification
results, blockers, and before another long tool stretch; to avoid empty status phrases; to keep progress
narration separate from `todo_write` accounting; and never to expose chain-of-thought
(`src/policy.ts:217-226`).

**When no systemPrompt service exists:** nothing is registered, no error is raised, and the file
`src/index.ts:167-180` is otherwise inert. The hard guard still works; the only loss is the *semantic*
obligation, leaving `progressMinChars` as the sole runtime criterion. Note also that a deployment using
a `complete: true` prompt section restores its own section as the sole prompt content, which would
suppress this contribution without affecting the guard.

---

## 9. Event ordering / worked timeline

Everything below is a consequence of the two verified facts in
[section 6](#6-lane-b--communication-freshness): `session.append` notifies `session/event` observers
synchronously (`DSHROOT/dsh-session/lib/index.js:1196-1203`), and the agent loop appends
`assistant/message` **before** dispatching that message's tool calls
(`DSHROOT/dsh-agent-loop/lib/index.js:1108-1118`).

Assume `progressBlockAfterCalls = 12`, a turn with no substantive text yet, and 11 ordinary calls already
admitted.

```text
1. step N — model responds with a tool call and no visible text
     session.append('assistant/message', { message: [tool-call] })
        └─ session/event fires synchronously
             isMeaningfulVisibleAssistant([...]) → false (0 non-whitespace chars)
             progressStates.has(session) is true → no reset; calls stays 11
     executeToolCalls(...)
        └─ guard: progressBlocked = (11 >= 12) = false
             progressState.calls += 1 → 12
             reminder at 8 already consumed; no reservation
        └─ tool body runs; tool/result appended

2. step N+1 — model responds with visible text AND the next tool call
     session.append('assistant/message', { message: [text("Root cause is X; patching Y, then rerunning Z."), tool-call] })
        └─ session/event fires synchronously, BEFORE any dispatch
             isMeaningfulVisibleAssistant(...) → true (>= 24 chars)
             resetProgress(session, turn) → progressStates = { calls: 0 }   ← budget cleared here
     executeToolCalls(...)
        └─ guard: progressBlocked = (0 >= 12) = false
             progressState.calls += 1 → 1
        └─ tool body runs (allowed)

3. step N+2 — model responds with a tool call and no visible text again
     session/event: no reset; calls stays 1
     guard: (1 >= 12) = false → allowed
```

The natural recovery from a hard checkpoint is therefore *a single model response containing both the
text and the tool call*: the text clears the budget during the append, and by the time the same
response's tool call reaches the guard the counter is already low. No synthetic assistant message, no
extra round trip, and no separate "unblock" step is required — which is precisely the property
`docs/DESIGN.md:30-48` illustrates. The denial path (a tool-only response at `calls >= 12`) is a
separate, also-supported case in which the model simply has to produce text on its next step.

---

## 10. Failure and edge cases

**Blocked-tool return shape.** One `isError` `tool/result` whose only block is
`{ type: 'text', text: 'Error: ' + reason }` and whose structured `error.message` is the bare `reason`
(`DSHROOT/dsh-tools/lib/index.js:3131-3138`). The tool body never runs. When both lanes are stale the
reason is `todoBlockedReason(...)` + `'\n\n'` + `progressBlockedReason(...)`
(`combinedBlockedReason`, `src/policy.ts:183-200`), so one denial names both obligations.

**Repeated blocks.** The guard returns *before* incrementing, so `calls` saturates at exactly
`blockAfterCalls` / `progressBlockAfterCalls` and every subsequent ordinary call is denied with a
byte-identical message. There is no escalation, no backoff, and no maximum retry count — the loop is
broken only when the model produces `todo_write` (Lane A) or ≥ `progressMinChars` of visible text
(Lane B). `todo_write` is always admitted, so Lane B's block can never lock the model out of task
accounting; conversely — and this is a real coupling — **while either lane is blocked the other lane's
counter is frozen too**, because the early `return` skips both increments. A stalled TODO lane therefore
also stalls the communication budget, and vice versa.

**`exemptTools` handling.** Normalized once at `apply` time (trim → drop empties → dedupe) and held in a
`Set` of raw `exec.name` values. Matching is exact-string against the tool name, so it must be the
registered name (e.g. `'session_search'`). Because `shouldCountTool` is checked *before* the block test
(`src/index.ts:192` vs `:198`), an exempt tool is not merely uncounted — it is **never blocked**, even
while both lanes are stale. The Schemastery layer accepts whitespace-only strings that `resolveConfig`
then discards, so `exemptTools: ['  ']` silently means "exempt nothing".

**Empty / whitespace-only text.** `visibleAssistantTextLength` returns `0` for no text blocks, for
`'   '`, and for `'\n\n'`, so `isMeaningfulVisibleAssistant(..., 24)` is false and the budget is not
reset. A 24-character content-free sentence *does* reset it — the helper is an explicit anti-empty-status
floor, not a quality score, and the semantic obligation lives in the prompt section and the reminder
text. Non-`text` blocks (`reasoning`, `tool-call`) never contribute.

**TODO lists that become fully complete.** `todo/write` with every item `completed` (or an empty list)
makes `hasUnfinishedTodos` false, so `todoStates.delete(session)` (`src/index.ts:122-125`) — Lane A
deactivates entirely: no reminders, no blocks, and no turn-stop reconciliation. Any unknown/future status
counts as unfinished and keeps the lane armed.

**Missing events.** A tool execution with no `exec.agent` returns immediately from the guard and
consumes nothing (`src/index.ts:185-186`). No `turn/start` (HMR) → the first observed
`assistant/message` seeds the progress budget regardless of its length. No `todo/write` → Lane A is
never armed. No `turn/end` → `progressStates` survives until the next `turn/start` replaces it.

**Where a budget can grow without bound.** **Nowhere** — both counters saturate at their block
thresholds. The only monotonic growth is the write-only global `epoch` (`++epoch` per reset, never
read), and the `reminders` `WeakMap` is keyed by the execution object, so an entry whose
`tools/post-execute` never runs is collected with the execution rather than accumulating. The
`sessions`/`turns` maps are `WeakMap`s, so they do not pin disposed sessions.

**Steering failures are contained.** `agent.steer` is called from `agent/turn-stopping`, not from
`session/event`; the Session append path rejects re-entrancy outright
(`DSHROOT/dsh-session/lib/index.js:1181`). A throwing or rejecting `session/event` listener is caught and
logged by the publisher and does not corrupt the log
(`DSHROOT/dsh-session/lib/types/index.d.ts:202-207`).

---

## 11. Known gaps / code-vs-prose discrepancies

> Correction note (2026-09-16): three rows below were fixed in the same change that produced this file —
> `README.md:75`, `README.md:94`, and `docs/DESIGN.md:22`. Each row still records what the prose said
> **before** the correction, so the audit stays reproducible.

| Claim (prose) | Verdict | Deciding code |
|---|---|---|
| `README.md:20-21` — reminder at 6, block at 10, ≤1 turn-stop reconciliation, `todo_write` never blocked, no auto-completion | **Verified** | `src/index.ts:191,198,214,264-276` |
| `README.md:27-31` — Lane B armed at turn start, 8/12, permanent prompt section | **Verified** | `src/index.ts:137-138,223,199,167-180` |
| `README.md:33` — `progressMinChars` = 24 non-whitespace Unicode chars, not a quality score | **Verified** | `src/policy.ts:104-125` |
| `README.md:35` — "DSH commits `assistant/message` before dispatching tool calls" | **Verified** | `DSHROOT/dsh-agent-loop/lib/index.js:1108-1118` + `DSHROOT/dsh-session/lib/index.js:1196-1203` |
| `README.md:39` — top-level `run_code` exempt, nested counted, `todo_write` reachable, TODO update does not reset communication | **Verified** | `src/policy.ts:127-140`, `src/index.ts:191,149-152` |
| `README.md:43` — never synthesizes Assistant chat bubbles | **Verified** | only `createUserMessage` is constructed (`src/index.ts:91-96`); no assistant message is ever appended |
| `README.md:75` — "patch rows replace the `config` value rather than deep-merging it, so include every option you care about" | **Stale / incomplete at audit time → corrected in `README.md`** | Replacement is real (`DSHROOT/dsh-app-boot/lib/index.js`, `applyEntryPatches`), but **both** config layers re-fill every omitted option with the hard-coded default (`src/index.ts:47-56`, `src/policy.ts:55-98`). Omitting an option reverts it to the default, not to the value in `cordis.patch.yml`. `cordis.patch.yml:5-11` in fact duplicates the defaults exactly. |
| `README.md:90` — prompt service optional; only `tools` is hard-injected | **Verified** | `src/index.ts:26,170-171` |
| `README.md:94` — "Current DSH deprecates synchronous `Session.eventAt()`, `snapshotEvents()`, and `ownEvents()` for new production code" | **Verified as upstream policy; imprecise as an API claim → wording corrected in `README.md`** | The current session README says the three readers "are deprecated … new production calls are prohibited" and links `.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`. The installed `0.1.5-rc.2` types declare all three with **no** `@deprecated` marker (`DSHROOT/dsh-session/lib/types/index.d.ts:178,187,192`) and `dsh-session` still calls them internally (`lib/index.js:1594,1606,1608`). The design rationale holds; only the "deprecated" wording needed to be distinguished from a removal. |
| `README.md:94` — on HMR mid-turn, communication resumes at the next `assistant/message`, TODO at the next `todo/write` | **Verified → gaps closed in `README.md`** | `src/index.ts:154-164,121-127`; the original prose omitted that a **non**-substantive first `assistant/message` also seeds the counter, and that the plugin-local `reconciledTurns` latch is lost on reload so the turn-stop steer can re-arm for the same turn. Both are now stated. |
| `README.md:97` — steer is best-effort at step boundaries; Session append rejects re-entrancy | **Verified** | `DSHROOT/dsh-agent/lib/types/runtime-types.d.ts:379-400`; `DSHROOT/dsh-session/lib/index.js:1181` |
| `README.md:99` — host-only, no client bundle | **Verified** | `package.json:8-19` (only `.`, `./policy`, YAML and manifest exports) |
| `docs/DESIGN.md:17` and `:22` — "6 soft / 10 hard, 8 soft / 12 hard… Each lane resets independently" | **Partially stale at audit time → reconciled in `docs/DESIGN.md`** | Thresholds are exact (`src/policy.ts:22-31`). Resets are independent (`src/index.ts:149-164`), but the counters are **coupled**: the shared `if (todoBlocked \|\| progressBlocked) return` (`:201-207`) freezes *both* counters whenever *either* lane is blocked. |
| `docs/DESIGN.md:52` — "prepends one plugin-sourced user-role context to `additionalContexts`" | **Verified** | `src/index.ts:236-261`; registry composition at `DSHROOT/dsh-tools/lib/index.js:3390` |
| `docs/DESIGN.md:58-60` — monotonic guard, both lanes combined, `todo_write` reachable, PTC rule | **Verified** | `src/index.ts:184,201-207,191`; `src/policy.ts:127-140` |
| `docs/DESIGN.md:64-69` — weak `progressMinChars`, semantic policy in the prompt | **Verified** | `src/policy.ts:104-125,217-226` |
| `docs/DESIGN.md:75` — latches `(session, turn)` to prevent a stop loop | **Verified** | `src/index.ts:264-275` |
| `docs/DESIGN.md:77` — never flips TODO statuses automatically | **Verified** | the plugin only reads `state.todos` (`src/index.ts:266-267`); `todo_write` is the only writer |
| `docs/DESIGN.md:81` — no custom durable event type | **Verified** | only first-party event names are listened to (`src/index.ts:134,143,149,154,265`) |

### Present in code but thin or absent in the prose

1. **Two config validation layers.** `README.md:75` now warns about the cross-field trap; the detail is
   that the schema enforces only per-field minimums (`reminderAfterCalls >= 1`, `blockAfterCalls >= 2`) and
   never `block > reminder`. `10/10` passes Schemastery, then throws inside
   `apply` with `todo-checkpoint-guard: blockAfterCalls must be greater than reminderAfterCalls`
   (`src/policy.ts:49-53,77-83`), so that mount registers nothing.
2. **Dead state.** `epoch` (both states) and `ProgressFreshnessState.turn` are written and never read;
   reminder staleness is detected by object identity (`src/index.ts:126,130,243,247`).
3. **Counter saturation and inter-lane freezing.** Documented above and now also in `docs/DESIGN.md`;
   relevant to anyone reasoning about the numbers in a combined block message.
4. **`exemptTools` are exempt from blocking, not just from counting** (`src/index.ts:192` precedes
   `:198`).
5. **Executions without `exec.agent` are silently unguarded** (`src/index.ts:185-186`).
6. **The guard is global**, so budgets are per-agent and each subagent has its own
   (`src/index.ts:184`).
7. **The `systemPrompt` probe is one-shot** (`src/index.ts:170`); there is no reaction to a service
   appearing later.
8. **Schemastery's object schema is non-strict** — unknown config keys are accepted and ignored.
9. **Runtime vs declared dependencies.** `lib/index.js` imports only
   `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-tools`. The declared
   peerDependencies `@deepseek-ai/cordis`, `dsh-agent`, `dsh-session` and `dsh-system-prompt` are
   **type-only** and are erased from the shipped build (`src/index.ts:1-23` vs `lib/index.js:1-14`).
10. **`lib/` matches `src/`.** A literal-and-structure comparison found no semantic divergence: the
    only differences are erased TypeScript types, erased `import type` declaration-merging side effects,
    and stripped comments. `node --check` passes on both emitted files.

### Untested paths

`test/policy.test.mjs` imports **only** `../lib/policy.js` (`:3-16`). The entire runtime wiring in
`src/index.ts` — event names, guard registration and blocking, reminder reservation/post-execute
delivery, the `systemPrompt` probe, the turn-stop steer, and every `WeakMap` transition — has **no test
coverage**. Also untested in `policy.ts`: `DEFAULT_CONFIG` and `TODO_WRITE_NAME` as exports,
`resolveConfig` with `NaN`/`Infinity`/non-integer input, and `visibleAssistantTextLength` with a
non-string `text` field. `docs/VERIFICATION.md:23-32` states the same limitation for the DSH boot path,
and it still holds here: `node_modules/` is empty, so `npm run typecheck` and a real profile boot were
not run.

---

## 12. Sources

### Repository (primary)

| File | Lines | Used for |
|---|---|---|
| `src/index.ts` | 25-26, 47-56 | plugin `name`, `inject`, Schemastery `Config` |
| `src/index.ts` | 58-82, 112-119 | state shapes, `apply`, `WeakMap` creation |
| `src/index.ts` | 121-165 | `session/event` handler, arming and reset rules |
| `src/index.ts` | 167-180 | optional `systemPrompt` probe and section registration |
| `src/index.ts` | 182-231 | guard, blocking, counter increments, reminder reservation |
| `src/index.ts` | 233-262 | `tools/post-execute` reminder delivery |
| `src/index.ts` | 264-276 | `agent/turn-stopping` reconciliation |
| `src/policy.ts` | 1, 22-31 | `TODO_WRITE_NAME`, `DEFAULT_CONFIG` |
| `src/policy.ts` | 42-98 | `resolveConfig` validation and normalization |
| `src/policy.ts` | 100-140 | `hasUnfinishedTodos`, text length, `shouldCountTool` |
| `src/policy.ts` | 142-226 | denial / reminder / prompt texts, combination helpers |
| `lib/index.js`, `lib/policy.js`, `lib/*.d.ts` | all | shipped build; compared against `src/` |
| `cordis.patch.yml` | 1-12 | the insert row and its config |
| `package.json` | 8-19, 30-34, 42-72 | exports, patch row, engines, deps and peerDeps |
| `test/policy.test.mjs` | 1-96 | asserted behavior and the import surface |
| `CHANGELOG.md` | 3-6 | 0.2.1 is documentation-only |
| `README.md`, `docs/DESIGN.md` | cited inline | claims checked in section 11 |

### Installed DSH contracts (`DSHROOT` = `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`)

Verified versions: `cordis` 4.0.2, `dsh-agent` / `dsh-llm` / `dsh-session` / `dsh-system-prompt` /
`dsh-tools` / `dsh-tool-todo` 0.1.5-rc.2, `schemastery` 3.18.2 — matching `package.json:46-71`.

| File | Lines | Contract |
|---|---|---|
| `dsh-session/lib/types/index.d.ts` | 62, 126, 178-207 | `session/event` signature, no seed emission, `eventAt`/`snapshotEvents`/`ownEvents`, synchronous append publication |
| `dsh-session/lib/index.js` | 1181, 1196-1203 | append re-entrancy rejection; synchronous observer invocation |
| `dsh-session/lib/types/types.d.ts` | 249-263, 309-317 | `turn/start`, `turn/end`, `assistant/message` payloads |
| `dsh-tool-todo/lib/types/types.d.ts` | 20-32 | `TodoItem`, `todo/write` payload `{ todos }` |
| `dsh-tool-todo/lib/index.js` | 96 | the registered tool name is `todo_write` |
| `dsh-tools/lib/types/index.d.ts` | 197-266 | `ToolExecutionInput`/`ToolExecution`: `agent?`, `name`, `parent?` |
| `dsh-tools/lib/types/index.d.ts` | 390-446 | `ToolExecutionResult`, `PostToolDecision.additionalContexts` |
| `dsh-tools/lib/types/index.d.ts` | 482-489, 611-620 | `ToolGuard`, `tools.guard()` monotonicity |
| `dsh-tools/lib/types/index.d.ts` | 303-306 | `post-result` still receives post-execute |
| `dsh-tools/lib/index.js` | 894, 3116-3148, 3377-3405, 3465-3481 | `RUN_CODE_NAME`, guard stage and materialized denial, post-execute composition |
| `dsh-tools/lib/types/ptc.d.ts` / `ptc.js` | 13 / 437-448 | `run_code` name; nested sub-calls run `scheduler.prepare` |
| `dsh-agent/lib/types/runtime-types.d.ts` | 379-400 | `agent/turn-stopping` is serial, awaited, steerable |
| `dsh-agent-loop/lib/index.js` | 1100-1119, 578-579 | `assistant/message` appended before `executeToolCalls`; `additionalContexts` → next-step inbox |
| `dsh-llm/lib/types/message.d.ts` | 82-110, 119-147 | `plugin` + `notice` form, `summary`, `createUserMessage` input, `UserMessage` |
| `dsh-llm/lib/types/types.d.ts` | 91-102 | merge-extensible `ContentBlock` union |
| `dsh-system-prompt/lib/types/index.d.ts` | 46-68, 138-141, 226-233 | `PromptSection`, `SECTION_ORDERS`, `SystemPrompt.section()` |
| `dsh-app-boot/lib/index.js` | `applyEntryPatches` | insert appends a row; non-insert patches replace each top-level key |
| `cordis/lib/types/reflect.d.ts` | 6-16 | `ctx.get(name, strict)` without inject |
| `cordis/lib/types/registry.d.ts` | 178-198 | `inject` waits for services; `Config` validated before `apply` |
| `cordis/lib/types/events.d.ts` | 88 | `ctx.on` returns a disposer |
| `schemastery/src/index.ts` | 470-495, 700-709 | default filling; object resolution |

### Upstream prose re-checked (fetched 2026-09-16)

| URL | What it establishes |
|---|---|
| https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/session/README.md | `session.append` "notifies observers"; `eventAt()`, `snapshotEvents()`, and `ownEvents()` "are deprecated: existing logic may remain unmigrated for now, but new production calls are prohibited", citing the 2026-09-09 deprecation policy note. This is the source behind `README.md:94` — a policy prohibition, not a removed or type-marked API. |

That URL is upstream `master`, read over the network on the fetch date; it is deliberately not treated as
evidence about the installed `0.1.5-rc.2` package, which was checked separately above.

### Commands actually run in this environment

```text
node test/policy.test.mjs          → 10 passed, 0 failed, exit 0
node --test test/*.test.mjs        → 1 failed (spawn EPERM), exit 1
node --check lib/index.js          → exit 0
node --check lib/policy.js         → exit 0
```

`node --test` uses a child process with piped stdio, which the DSH file sandbox denies (`EPERM`); the
test file itself passes in-process. `npm run typecheck` / `npm run build` were **not** run —
`node_modules/` is absent and this session has no approval to widen access. A live DSH profile boot was
likewise not performed, so the end-to-end mounting of `cordis.patch.yml` and the two
`ctx.effect` registrations remain **verified by contract only, not by execution**.
