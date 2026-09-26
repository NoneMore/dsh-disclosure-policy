# How `dsh-disclosure-policy` works

Implementation walkthrough for the **current checkout**, updated 2026-09-26 for ADR-0005. Installed-tree citations below retain their historical 2026-09-16 audit snapshot; current behavior is checked against source and tests.

- `DSHROOT` = `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
- Verified package versions: `dsh-*` `0.1.5-rc.2`, `cordis` `4.0.2`, `schemastery` `3.18.2`.
- Claim convention: `path:line` means I read that line in the tree above. Anything derived rather than read is marked **INFERENCE**.

This document describes the shipped code, not the design intent. The design is in `DESIGN.md`; the claim-by-claim provenance is in `SOURCES.md`. `README.md` and `DESIGN.md` are treated as *claims to check*, never as evidence.

Research snapshot: 2026-09-16.

---

## 1. Summary

The plugin contributes three things:

| Contribution | Where |
|---|---|
| A static disclosure policy in the system prompt, order `10150` | `systemPrompt.section()` via `ctx.effect()` |
| One turn-local disclosure projection per session | `session/event` listener |
| At most `maxReminders` soft reminders per disclosure interval, one per cadence period | `tools/post-execute` → `additionalContexts` |

Everything decidable lives in `src/policy.ts`, which imports nothing from the host. `src/index.ts` is a thin adapter — about 60 lines of code plus comments — over those decisions. `lib/` is the compiled output of `src/` and is what the tests exercise.

There is no guard, no `todo` access, no steering, and no durable event.

---

## 2. Mount and registration

### Patch row

`cordis.patch.yml` inserts one row:

```yaml
- insert:
    - id: disclosure-policy
      name: dsh-disclosure-policy
      config:
        reminderAfterCalls: 8
        maxReminders: 3
```

`package.json` publishes it through `dsh.bundle.patch`, which is the installable-bundle convention (`docs/SOURCES.md` section A).

### Plugin shape

```ts
export const name = DISCLOSURE_PLUGIN_NAME
export const inject = ['tools']
export const Config: z<Config> = z.object({
  reminderAfterCalls: z.number().step(1).min(0).default(DEFAULT_CONFIG.reminderAfterCalls),
  maxReminders: z.number().step(1).min(0).default(DEFAULT_CONFIG.maxReminders),
})
```

`tools` is a hard dependency because the reminder is delivered through the tool pipeline. The plugin needs no other service to do its job.

### The optional `systemPrompt` probe

The prompt section is installed only if the service exists:

```ts
const systemPrompt = ctx.get('systemPrompt')
if (systemPrompt !== undefined) {
  ctx.effect(() => systemPrompt.section({
    name: DISCLOSURE_POLICY_SECTION_NAME,
    order: DISCLOSURE_POLICY_ORDER,
    text: DISCLOSURE_POLICY_TEXT,
  }))
}
```

`inject` is for hard dependencies; optional capabilities are probed with `ctx.get()` (`docs/SOURCES.md` section A). Registering the section inside `ctx.effect()` ties its disposer to the plugin fiber, so hot reload removes it cleanly. `systemPrompt.section()` itself returns that disposer (`DSHROOT/dsh-system-prompt/lib/types/index.d.ts:233`).

A deployment that installs a `complete: true` prompt section can suppress every external section. In that case the reminder still works; only the standing text is missing.

### What is deliberately *not* registered

The repository's test suite asserts the registration surface directly, using a fake `ctx` over the built `lib/index.js`:

```js
assert.deepEqual(harness.eventNames().sort(), ['session/event', 'tools/post-execute'])
assert.equal(harness.guards.length, 0)
```

so a future edit that adds a guard, a `todo/write` listener, or a `turn-stopping` steer fails the suite.

---

## 3. Config

| Option | Schema | Default |
|---|---|---|
| `reminderAfterCalls` | `z.number().step(1).min(0)` | `8` |
| `maxReminders` | `z.number().step(1).min(0)` | `3` |

`resolveConfig()` in `src/policy.ts` re-validates the same rule (`Number.isSafeInteger && >= 0`) for both and throws `disclosure-policy: reminderAfterCalls must be a non-negative safe integer` or `disclosure-policy: maxReminders must be a non-negative safe integer` otherwise. The schema catches malformed DSH config rows before `apply`; the pure check keeps the policy module authoritative for direct callers and for the tests.

Setting either option to `0` disables runtime reminders and leaves the standing policy installed. `maxReminders: 1` is the historical one-shot cadence. Those are the only two behavioral options; there are no cadence tiers, tool exemptions, or prose-length thresholds.

### The patch row's `config` replaces, it does not deep-merge

DSH copies a patch's remaining top-level fields — including `config` — onto the matched row (`DSHROOT/dsh-app-boot/lib/index.js:59-105`), and both config layers re-fill omitted options from the plugin's hard-coded defaults. A partial override therefore reverts unlisted options to the defaults rather than inheriting `cordis.patch.yml`. With one option this is only a documentation concern, but the note stays because it is a real trap for future options.

---

## 4. State model

The exported state/helper names retain their historical `Silence` spelling for API compatibility; the state now measures a disclosure interval.

```ts
interface SilenceState {
  calls: number                    // completed top-level calls since it opened
  firstReminderAt: number | null   // call count where the first reminder was delivered
  delivered: number                // reminders delivered, and the budget index of the next
}

interface ActivityState {
  inspect: number
  mutate: number
  verify: number
  other: number
}
```

Storage is a per-`apply` `WeakMap<Session, { silence: SilenceState; activity: ActivityState }>`, so both projections are plugin-local and die with the session or the fiber. Activity is context for the one reminder lane, not a second trigger or budget.

Lifecycle:

| Event | Effect |
|---|---|
| `turn/start` | creates fresh disclosure and activity projections |
| `assistant/message` with recognized structured model disclosure | resets both projections |
| every `tools/post-execute` | classifies `exec.name` into activity; top-level calls also advance disclosure cadence |
| `turn/end` | discards the interval |

`turn/start` is the **only** initialization point. Nothing scans session history, which is what current DSH policy requires for new production code (`docs/SOURCES.md` section A). The cost is explicit: a hot reload mid-turn does not reconstruct the current interval, so accounting starts at the next `turn/start`.

**INFERENCE:** an `assistant/message` arriving before any `turn/start` (for example a resumed session replaying surface events) simply does nothing, because no record exists yet.

---

## 5. Observation: `session/event`

`session/event` is declared on the Cordis `Events` interface as `(session: Session, event: SessionEvent) => void` (`DSHROOT/dsh-session/lib/types/index.d.ts:62`). It fires post-commit, inside the append boundary — `DSHROOT/dsh-session/lib/index.js:1181` is the guard that rejects a re-entrant append from that window. The listener therefore only mutates local state: it never appends, never steers, and never awaits.

### `turn/start`

Payload is `{ turn: number }` (`DSHROOT/dsh-session/lib/types/types.d.ts:249-251`).

### `turn/end`

Payload is `{ turn: number; reason: TurnEndReason }` (`:260-263`). The record is discarded; there is no "turn ended without disclosure" verdict, because a turn ending proves nothing about whether the supervisor was informed.

### `assistant/message`

Payload is `{ turn, step, message, stream, usage?, interrupted? }` (`:309-317`); `message` is an `AssistantMessage` whose `source` is a `ModelMessageSource` with `kind: 'model'` (`DSHROOT/dsh-llm/lib/types/message.d.ts:18-20`, `:135-138`).

`isModelDisclosure()` accepts the message only when **all three** hold:

1. `role === 'assistant'` — tool results and injected context are user-role;
2. `source.kind === 'model'` — plugin-authored context is never disclosure;
3. Its entire visible text matches the agreed four-line structure, with all three content fields non-empty and in order.

Condition 3 is a local expression contract (ADR-0005): concatenate visible text blocks in order, exclude reasoning and tool-call blocks, and trim surrounding whitespace. Accept `Disclosure / Done / Next / Approach` or `披露 / 已做 / 将做 / 做法`, using `:` or `：` separators. An empty heading body and three non-empty fields are required. Mixed labels, missing fields, fenced or indented code blocks, quotations, embedded examples, and extra prose fail recognition. Repeated complete structures still reset; the runtime does not review semantics.

There is **no** commentary/final discriminator anywhere in the installed build, so the plugin makes no phase claim: only complete structured model disclosure counts (`docs/SOURCES.md` section H).

The message is committed before the tool calls it requested are dispatched, which is why visible text and a tool call in one model response compose cleanly (`docs/SOURCES.md` section G).

---

## 6. Counting and the reminder: `tools/post-execute`

`tools/post-execute` is an ordered waterfall: `(exec, result, next) => Promise<PostToolDecision>` (`DSHROOT/dsh-tools/lib/types/index.d.ts:61`). `PostToolDecision` carries `additionalContexts?: UserMessage[]` on both `accept` variants and on `block` (`:432-446`).

The listener does three things in order:

```ts
const downstream = await next()                       // 1. let downstream policy decide
const state = exec.agent === undefined ? undefined : silences.get(exec.agent.session)
if (state === undefined) return downstream
const index = countCompletedCall(state, config.reminderAfterCalls, config.maxReminders, {
  nested: exec.parent !== undefined,
})
if (index === null) return downstream
markReminderDelivered(state, state.calls, index)      // 2. spend a budget slot only here
return withReminder(downstream, notice(reminderTextFor(index)))  // 3. compose, do not replace
```

### Why `tools/post-execute` and not a guard

`tools/post-execute` is the only extension point that both observes a settled call and can attach model-facing text. `ctx.tools.guard()` is a monotonic deny with no allow result (`DSHROOT/dsh-tools/lib/types/index.d.ts:481-489`, `:611-620`); it cannot deliver a reminder, and this plugin has no hard invariant to protect. See ADR-0001.

### Every settled top-level call counts

`postExecute()` runs for every dispatch outcome, and the pipeline routes a pre-execute denial back through it: a pre-policy denial materializes `{ kind: 'post-result', exec, result }` (`DSHROOT/dsh-tools/lib/index.js:3127-3139`), which `finalizeScheduledExecution()` then passes to `postExecute()` (`:3241-3243`). So the count is independent of success, failure, or another policy's denial — exactly as specified — without the plugin inspecting the result at all. If a downstream post-execute listener throws, the plugin advances the count before rethrowing but does **not** call `markReminderDelivered`, so the throwing boundary cannot consume a budget slot; the anchor stays unset and the reminder is delivered at the next boundary that can carry `additionalContexts`.

### Nested calls do not count for cadence, but they do count for activity

`ToolExecutionInput.parent` is the opaque token of the enclosing transport execution; PTC mode sets it on SDK sub-dispatches (`DSHROOT/dsh-tools/lib/types/index.d.ts:209-218`). `countCompletedCall(..., { nested: exec.parent !== undefined })` returns immediately for those, so a `run_code` program that dispatches fifty native calls advances the disclosure interval once, for its own top-level call. The activity projection still classifies each completed nested tool by its structured `exec.name`, so composite transports cannot hide a large inspection/search stretch from the factual reminder context.

### At most one reminder per cadence period, up to the interval budget

`countCompletedCall()` mutates the interval and returns the budget index of the reminder this call carries, or `null`:

```ts
state.calls += 1
if (reminderAfterCalls <= 0 || maxReminders <= 0) return null

const index = state.delivered
if (index >= maxReminders) return null

const dueAt = state.firstReminderAt === null
  ? reminderAfterCalls
  : state.firstReminderAt + index * reminderAfterCalls
if (state.calls < dueAt) return null

return index
```

The first reminder anchors the cadence at the threshold call, and each later one is due `reminderAfterCalls` calls after that anchor, which is why a parallel step crosses at most one period and yields at most one notice. Because the anchor is set by `markReminderDelivered` rather than by counting alone, a boundary that cannot deliver leaves the anchor unset and the cadence starts at the next boundary that can. The counter is never reset by a reminder, so it keeps measuring the interval until recognized structured model disclosure opens a new one.

The returned index selects the base/repeat text. Before composition, `inspectionActivityFact()` may add one objective suffix when the interval contains at least `reminderAfterCalls` inspection/search operations and no mutation- or verification-oriented operation. The suffix reports the observed mix and asks which unresolved fact would justify more investigation; it does not create a new reminder or label the work as excessive. Index `0` still uses the base request, and any later index also appends `DISCLOSURE_REPEAT_TEXT` (ADR-0004).

### Composition

`withReminder()` preserves the downstream decision and prepends our notice:

```ts
const additionalContexts = existing === undefined ? [reminder] : [reminder, ...existing]
return { ...decision, additionalContexts }
```

This matters because `block` decisions survive as blocks (`DSHROOT/dsh-tools/lib/index.js:3380-3388`), `accept` value replacements survive as replacements (`:3391-3399`), and a result transformer such as `dsh-spill-policy` keeps its rewritten content. The runtime tests cover all three arms and assert that a downstream context stays *after* ours.

### Where the notice lands

The registry merges the tool body's deferred contexts first and the decision's contexts second (`DSHROOT/dsh-tools/lib/index.js:3390`); the agent loop then reads `result.additionalContexts` in `runGroup()` and pushes each into the next-step inbox (`DSHROOT/dsh-agent-loop/lib/index.js:578`, spliced at `:1118`). The notice therefore becomes model-visible at the **next step boundary** — it cannot change the request already in flight, and it cannot interrupt a running tool.

### Notice shape

```ts
createUserMessage({
  content: [{ type: 'text', text: reminderTextFor(index) }],
  source: { kind: 'disclosure-policy', form: 'notice', summary: 'Disclosure reminder' },
})
```

`createUserMessage` requires both `content` and `source` (`DSHROOT/dsh-llm/lib/types/message.d.ts:180-183`); `form: 'notice'` requires a `summary` bounded to `CONTEXT_SUMMARY_MAX_CHARS = 120` (`:81-85`, `:110`). The summary is a static two-word label, not a runtime fact.

The request includes the concise four-line expression contract for recent work, next action, and approach. A repeat adds one fixed sentence stating that no complete structured disclosure has been observed in this stretch; ordinary visible prose may have occurred. Both avoid a counter, a threshold, a denial threat, a question, a reasoning request, and any statement of the remaining budget; the pure tests assert exactly that.

---

## 7. System prompt section

`section()` takes `{ name, order, text }`; sections are concatenated in ascending order and equal orders break on name (`DSHROOT/dsh-system-prompt/lib/types/index.d.ts:47-68`). The audited order table puts `WEB_SURFACE` at `10100` and `DEPLOYMENT_PERSONA_SUFFIX` at `10200` (`:139-140`), so the plugin's `10150` lands after first-party Web-surface guidance and before the deployment persona suffix.

The section text is a constant. It carries no counters and no timestamps, which is deliberate: the assembled prompt is a `system`-role entry inside `messages`, and a route that reads the latest `system` message appends a full copy whenever the rendering changes, while every other route rewrites node 0 in place. Volatile prompt text invalidates the cached prefix from an early token either way; `.scratch/research/prompt-cache-and-volatile-text.md` traces the mechanism. Per-turn state therefore lives only in appended context.

The section states the semantic obligation in full: the six material moments, the three content fields and expression format, no opening-preamble requirement, the question-only-when-blocked rule, and the chain-of-thought prohibition.

---

## 8. Worked timeline

```text
turn/start(turn 3)
  -> state = { calls: 0, firstReminderAt: null, delivered: 0 }

model replies with reasoning only, then calls read
  -> assistant/message: reasoning block only -> interval unchanged
  -> tools/post-execute(read): calls = 1

model calls grep, glob, read, search, fetch, read, grep   (7 more top-level calls)
  -> calls = 8 == reminderAfterCalls on the eighth settling call
  -> activity is inspection-only, so the notice includes the observed inspection count
  -> that call's post-execute decision gains one plugin notice (index 0)
  -> the notice enters the next-step inbox

model sends ordinary prose and keeps calling tools  (8 more calls)
  -> calls = 16 -> second notice (index 1, repeat sentence appended)

model's next step sees the notice and emits a complete structured disclosure plus a tool call
  -> assistant/message with visible text -> resets disclosure accounting and activity
  -> its tool call settles -> calls = 1 and starts the new activity mix

turn/end
  -> state discarded
```

Parallel variant: if six calls settle from one step and the interval crosses a cadence period inside that batch, exactly one of them carries that period's notice and the rest return untouched.

Budget variant: after `delivered` reaches `maxReminders` the interval stays silent for every later call, however many settle, until recognized structured model disclosure opens a new one.

Denied variant: a call denied by another policy still returns through `post-execute`, so it advances the interval and can carry the notice like any other call.

---

## 9. Failure and edge cases

- **No state yet.** Before the first observed `turn/start`, `tools/post-execute` returns the downstream decision untouched. Nothing is counted and nothing is reminded.
- **No agent on the execution.** `exec.agent` is optional (`DSHROOT/dsh-tools/lib/types/index.d.ts:208`); when it is absent there is no session to key on, so the listener returns untouched.
- **A downstream listener throws.** `next()` rejects, the error propagates, and the registry materializes a tool error result (`DSHROOT/dsh-tools/lib/index.js:3245-3247`). The completed top-level call still advances the interval, but no budget slot is spent. Because the throwing boundary cannot carry a decision, a newly due reminder stays pending and is attached at the next deliverable boundary.
- **A downstream listener blocks.** The plugin keeps the `block` arm and prepends its context; a blocked call still counts, because it settled.
- **`systemPrompt` absent or superseded.** The plugin mounts and reminds normally; only the standing text is missing.
- **Repeated `turn/start` for the same session.** The record is replaced, which is the intended reset.
- **`turn/end` without a preceding `turn/start`.** `WeakMap.delete` is a no-op; nothing throws.

---

## 10. Known gaps and code-vs-prose notes

- **Hot reload loses the current interval.** By design: no history scan. The first reminder after a reload can be delayed to the next turn.
- **The threshold is a failsafe, not a semantic trigger.** Nothing in DSH exposes "a phase completed" or "a test now passes", so `reminderAfterCalls` measures calls since recognized disclosure, not task progress. The standing policy carries the meaning.
- **Activity shape is deliberately shallow.** It classifies structured tool names, not arbitrary shell command text, and says nothing about whether an operation was useful, whether a mutation actually changed files, or whether a verification proved the task correct.
- **A reminder can be ignored.** Disclosure is best-effort; the plugin has no way to compel it and does not try (ADR-0003). ADR-0004 raises the cost of staying silent with a bounded repeat cadence, but an interval that spends its whole budget is still silent for the rest of that turn.
- **Complete structure is the reset, and content is not scored.** Ordinary prose cannot open a new interval. Vague, repeated, or false complete structures still can; the plugin checks expression rather than prose quality (ADR-0005).
- **The interval does not survive `turn/end`.** A model that keeps opening fresh turns is not covered by the cadence (ADR-0004).
- **No commentary phase exists in this build.** The plugin never claims that a given assistant message is interim or final; it recognizes structure in model-authored visible text.
- **The real-profile check covered boot, not a model turn.** An isolated Web profile loaded the packed plugin and listened successfully, but no live model turn was driven through the reminder threshold; see `docs/VERIFICATION.md`.

---

## 11. Sources

### Repository (primary)

- `src/policy.ts`, `src/index.ts`, `lib/index.js` — the implementation described above.
- `test/policy.test.mjs`, `test/runtime.test.mjs` — the behavioral contract.
- `docs/DESIGN.md`, `docs/SOURCES.md`, `docs/adr/0001-supervision-over-enforcement.md`, `docs/adr/0003-model-authored-disclosure.md`, `docs/adr/0004-bounded-repeat-reminders.md`.

### Installed DSH contracts (`DSHROOT` = `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`)

| Contract | Location |
|---|---|
| `session/event` dispatcher | `dsh-session/lib/types/index.d.ts:62` |
| `turn/start` / `turn/end` / `assistant/message` payloads | `dsh-session/lib/types/types.d.ts:249-251`, `:260-263`, `:309-317` |
| Session append non-reentrancy guard | `dsh-session/lib/index.js:1181` |
| `tools/post-execute` waterfall | `dsh-tools/lib/types/index.d.ts:61` |
| `PostToolDecision.additionalContexts` | `dsh-tools/lib/types/index.d.ts:432-446` |
| `ToolExecutionInput.agent` / `.parent` | `dsh-tools/lib/types/index.d.ts:208`, `:218` |
| Deny path re-enters post-execute | `dsh-tools/lib/index.js:3127-3139`, `:3241-3243` |
| post-execute decision application | `dsh-tools/lib/index.js:3377-3406` |
| Next-step context delivery | `dsh-agent-loop/lib/index.js:578`, `:1118` |
| Guard is deny-only | `dsh-tools/lib/types/index.d.ts:481-489`, `:611-620` |
| `systemPrompt.section()` and section orders | `dsh-system-prompt/lib/types/index.d.ts:47-68`, `:139-140`, `:233` |
| `createUserMessage`, `notice` form, summary bound | `dsh-llm/lib/types/message.d.ts:81-85`, `:110`, `:180-183` |
| `ModelMessageSource.kind === 'model'` | `dsh-llm/lib/types/message.d.ts:18-20` |

### Commands run in this environment

```bash
npm install --cache ./.npm-cache     # local cache because the default npm cache is outside the sandbox
npm run typecheck
npm run build
npm test                             # current results: docs/VERIFICATION.md
node --check lib/index.js
node --check lib/policy.js
```
