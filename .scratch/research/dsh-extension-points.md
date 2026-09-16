# DSH extension points for a "report progress more often" policy plugin

Audit of the **installed** tree at
`E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\` (referred to below as `$DSH`).

Package layout discovered: `$DSH/lib/` is (near) empty; every real package is a
sibling install under `$DSH/node_modules/@deepseek-ai/dsh-*`. Packages ship
compiled `lib/index.js` **plus** `lib/types/*.d.ts`, so exact signatures and
doc-comments are readable from the `.d.ts` files. Line numbers below are from
those files.

Convention: claims read directly from the tree are cited as `path:line`; anything
I derived rather than read is marked **INFERENCE**.

---

## 0. Version (question 10)

| package | version | source |
|---|---|---|
| `@deepseek-ai/dsh` (installer/meta) | **0.1.5-rc.1** | `$DSH/package.json` (`name`, `version`) |
| `dsh-tools` | 0.1.5-rc.2 | `.../dsh-tools/package.json` (`main: lib/index.js`) |
| `dsh-session` | 0.1.5-rc.2 | `.../dsh-session/package.json` |
| `dsh-agent` | 0.1.5-rc.2 | `.../dsh-agent/package.json` |
| `dsh-agent-loop` | 0.1.5-rc.2 | `.../dsh-agent-loop/package.json` |
| `dsh-system-prompt` | 0.1.5-rc.2 | `.../dsh-system-prompt/package.json` |
| `dsh-tool-todo` | 0.1.5-rc.2 | `.../dsh-tool-todo/package.json` |
| `dsh-user-approval` | 0.1.5-rc.2 | `.../dsh-user-approval/package.json` |
| `dsh-user-questions` | 0.1.5-rc.2 | `.../dsh-user-questions/package.json` |
| `dsh-tool-ask-user` | 0.1.5-rc.2 | `.../dsh-tool-ask-user/package.json` |
| `dsh-repeat-tool-reminder` | 0.1.5-rc.2 | `.../dsh-repeat-tool-reminder/package.json` |
| `dsh-session-checkpoint-policy` | 0.1.5-rc.2 | `.../dsh-session-checkpoint-policy/package.json` |

The installer is one patch release *behind* the packages it installs
(0.1.5-rc.1 vs 0.1.5-rc.2). **INFERENCE**: version skew of a single rc patch;
nothing in the audited contracts depends on the meta-package version.

Deployment composition (which rows are actually mounted) is *not* inside these
packages: the host plane is `dsh-base/cordis.patch.yml` (+ per-product patches
`dsh-web-app/cordis.patch.yml`, `dsh-headless/…`, `dsh-acp-app/…`), and the agent
plane is the shipped presets, e.g.
`dsh-agent-presets/presets/standard/agent.cordis.yml`.

---

## 1. Tools + pipeline (question 1)

### 1.1 Pipeline order

`ToolRuntime.execute()` runs one call through six ordered stages. Declared in the
class doc-comment at `dsh-tools/lib/types/index.d.ts:716-730`:

> "Execute through pre-policy, guards, around-dispatch, post-policy,
> definition-owned content finalization, and final notification."

The concrete implementations, in the order the agent loop drives them:

| # | stage | where |
|---|---|---|
| 1 | materialize/validate args, mint execution token | `dsh-tools/lib/index.js:3106` (`createExecution`) |
| 2 | caller-cancellation precheck (`ABORTED_BEFORE_DISPATCH`) | `dsh-tools/lib/index.js:3109-3113` |
| 3 | **`tools/pre-execute`** waterfall (default `{kind:'allow'}`) | `dsh-tools/lib/index.js:3116` |
| 3b | `ask` resolution through the approval seam | `dsh-tools/lib/index.js:3117-3121`, `3314-3365` |
| 4 | **guards** (only when the pre-execute decision was `allow`) | `dsh-tools/lib/index.js:3127` |
| 5 | **`tools/execute`** waterfall → `dispatchToolBody` → `await tool.execute(...)` | `dsh-tools/lib/index.js:3213`, `3176-3201` (await at `3192`) |
| 6 | deferred `additionalContexts` from the body are prepended | `dsh-tools/lib/index.js:3215-3221` |
| 7 | **`tools/post-execute`** waterfall + decision application | `dsh-tools/lib/index.js:3377-3406` |
| 8 | definition-owned `finalizeContent` → materialize (`:3465`) → **`tools/result`** emit | `dsh-tools/lib/index.js:3241-3270`, `3284-3292` |

Deny path: a denial (from pre-execute `deny`/`ask` or a guard) is materialized as
an `isError` result **and still goes through `post-execute`** (`kind:'post-result'`
at `dsh-tools/lib/index.js:3128-3139`); only `final-result` stages bypass it
(`dsh-tools/lib/index.js:307-318`).

The loop drives the stages through an internal scheduler symbol, not
`execute()`: `dsh-agent-loop/lib/index.js:588` (`prepare`), `:592` (`dispatch`),
`:576` (`finalize`/`finish`).

### 1.2 Exact event signatures

`dsh-tools/lib/types/index.d.ts:28-94` (declared on the Cordis `Events` interface):

```ts
// :38 — @mode waterfall
'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution,
                    next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;

// :49 — @mode waterfall
'tools/execute'(this: Scoped<ToolRuntime>, exec: ToolDispatchExecution,
                next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>;

// :61 — @mode waterfall
'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution,
                     result: Readonly<ToolExecutionResult>,
                     next: () => Promise<PostToolDecision>): Promise<PostToolDecision>;

// :75 — @mode waterfall (durable log copy only; not model-visible)
'tools/ptc-dispatch-log'(...): Promise<ContentBlock[]>;

// :83 — @mode emit (frozen lossless-JSON snapshot)
'tools/result'(this: Scoped<ToolRuntime>, exec: Readonly<ToolExecution>,
               result: Readonly<ToolExecutionResult>): undefined;

// :93 — @mode emit
'tools/change'(): void;
```

Decision unions (`dsh-tools/lib/types/index.d.ts:419-446`):

```ts
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask';   reason?: string };

export type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue;          content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block';  feedback: ContentBlock[];  additionalContexts?: UserMessage[] };
```

`additionalContexts` are `UserMessage[]` on **both** accept variants and on
`block` (`:436`, `:441`, `:445`). They are also legal on the *result* itself:
`ToolExecutionSuccess.additionalContexts?: UserMessage[]` (`:397`) and
`ToolExecutionFailure.additionalContexts?: UserMessage[]` (`:408`).

### 1.3 `ctx.tools.guard()`

```ts
// dsh-tools/lib/types/index.d.ts:489
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined;

// dsh-tools/lib/types/index.d.ts:620
guard(guard: ToolGuard): () => void;
```

Doc at `:481-489`: *"A monotonic execution guard evaluated after every
`tools/pre-execute` listener and before the tool body. Returning a reason denies
the call; returning `undefined` leaves it unchanged. **Because guards have no
allow result, listener ordering cannot turn a denial back into permission.**"*
Class doc at `:610-620`: *"Any matching guard may deny by returning a reason,
while no guard can force-allow a call another guard denied."*

**Confirmed: a guard can only deny. There is no allow result.**

Guard evaluation is skipped entirely when pre-execute already decided `deny` or
`ask`-denied — `const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;`
(`dsh-tools/lib/index.js:3127`). Resolution order is global layer first, then the
scope chain farthest-first (`dsh-tools/lib/index.js:2823-2830`, `:2550`).

### 1.4 Can post-execute inject model-facing context on accept *and* block?

**Yes, verified in code.** `postExecute` (`dsh-tools/lib/index.js:3377-3406`):

- `block` → returns `{ content: decision.feedback, isError: true, error: {message}, additionalContexts: decisionContexts }`
  (`:3380-3388`) — context survives the block.
- `accept` → `const additionalContexts = [...result.additionalContexts ?? [], ...decisionContexts];`
  (`:3390`) then attached to the returned result on both the value-replacement
  (`:3396-3399`) and content-replacement/pass-through (`:3401-3405`) arms.
- A `block` **discards** contexts the *tool body* deferred; only the blocking
  decision's own contexts survive (`:3372-3374` doc, `:3386` code).

Where the contexts actually land: the loop's `commitReady()`
(`dsh-agent-loop/lib/index.js:571-582`) reads `result.additionalContexts` and
calls `acceptContext(context)`; that callback is `(context) => this.inbox.splice("next-step", this.inbox.nextStep.length, 0, [context])`
(`dsh-agent-loop/lib/index.js:1118`). So `additionalContexts` enter the
**next-step inbox** and become model-visible only at the *next* step boundary,
as a user-role message — they do **not** alter the current request.

---

## 2. Session events (question 2)

### 2.1 The authoritative type union

`dsh-session/lib/types/types.d.ts:242-404` declares `interface SessionEventMap`
(merge-extensible). The generated closed vocabulary of everything this build
understands is `dsh-session/lib/types/known-event-types.js:21-78`
(`KNOWN_SESSION_EVENT_TYPES`), 47 entries. Directly relevant ones:

```
'assistant/attempt', 'assistant/message', 'step/start', 'step/end',
'turn/start', 'turn/end', 'tool/call', 'tool/result', 'user/message',
'system/message', 'todo/write', 'request/header', 'request/context',
'session/end-seed', 'approval/asked', 'approval/decided', 'approval/policy',
'compaction/*', 'subagent/*', 'tool-workflow/*', 'llm/retry', 'goal/change',
'plan/mode', 'sandbox/mode', 'permission/preset', 'model/selection',
'agent-preset/selected', 'agent/inbox/spliced', 'session/title', ...
```

The append API: `Session.append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts)`
(`dsh-session/lib/types/index.d.ts:238`).

### 2.2 Payload shapes for the events a progress policy cares about

```ts
// types.d.ts:249-251
'turn/start': { turn: number };

// types.d.ts:260-263
'turn/end': { turn: number; reason: TurnEndReason };

// types.d.ts:265-273
'step/start': { turn: number; step: number };
'step/end':   { turn: number; step: number };

// types.d.ts:281 (UserMessage; message.d.ts:131-133)
'user/message': UserMessage;   // { id, role:'user', content: ContentBlock[], source: MessageSource }

// types.d.ts:294-298
'system/message': { turn: number; step: number; message: SystemMessage };

// types.d.ts:309-317
'assistant/message': {
  turn: number; step: number;
  message: AssistantMessage;
  stream: AssistantStreamRecord[];   // exact timed model stream, compacted
  usage?: TokenUsage;
  interrupted?: true;                // cancelled mid-stream prefix
};

// types.d.ts:323-327 (attempt that committed no surface message)
'assistant/attempt': { turn: number; step: number; stream: AssistantStreamRecord[] };

// types.d.ts:333-339
'tool/call': { turn: number; step: number; callId: ToolCallId; name: string; arguments: string /* raw JSON, unparsed */ };

// types.d.ts:351-361
'tool/result': {
  turn: number; step: number;
  message: ToolResultMessage;        // { id, role:'user', content:[ToolResultBlock], source:{kind:'tool',callId} }
  error?: { name: string; code: string };   // only when the block isError:true
  meta?: JsonValue;
};

// dsh-tool-todo/lib/types/types.d.ts:26-33
'todo/write': { todos: TodoItem[] };   // TodoItem = { content: string; status: 'pending'|'in_progress'|'completed' }
```

`TurnEndReason` (`types.d.ts:165-201`) is a merge-extensible union with variants
`completed` | `aborted` (`reason: TurnEndCancelCause`) | `blocked` | `error`
(`error: LlmFailure`) | `max-tokens` | `interrupted`. There is **no** `turn/end`
reason for "progress was reported".

**`todo/write` is log-only UI state, never derived history** —
`dsh-tool-todo/lib/types/types.d.ts:28`: *"Whole-list snapshot; latest write wins
on replay. Log-only UI state; never derived history."* Its projection is
`SessionProjectionMap.todos: TodoItem[] | null` (`:38-45`).

### 2.3 Does `assistant/message` distinguish interim from final text?

**No. All visible text is one undifferentiated field.**

- The payload is `{ turn, step, message, stream, usage?, interrupted? }`
  (`types.d.ts:309-317`). There is no phase/kind/final flag.
- `AssistantMessage` is `{ id, role: 'assistant', content: ContentBlock[], source: ModelMessageSource }`
  (`dsh-llm/lib/types/message.d.ts:135-138`) — again no phase field.
- `ContentBlock` kinds are only `text | reasoning | image | file | tool-call | tool-result`
  (`dsh-llm/lib/types/types.d.ts:39-102`); there is no commentary variant.
- The only structur*ing* signal is **positional**: `turn` + `step`. Interim
  visible prose is simply a text-bearing `assistant/message` in an earlier step,
  or in a step that also contains `tool-call` blocks.

Grep over the whole install for `commentary` and `interim` returns **no matches**
in any `.d.ts` or `.js` under `$DSH/node_modules/@deepseek-ai/`. The terms do not
exist in this build. (**INFERENCE**: a plugin cannot ask DSH "is this text a
progress note or the final answer?" — it must infer it, exactly as the client
does; see §7.)

`assistant/message` is a `SurfaceEventType` (`types.d.ts:413`), so the surface
(`deriveMessages()`, `index.d.ts:285`) treats every one of them as ordinary
conversation history.

---

## 3. Steering (question 3)

### 3.1 `agent.steer()`

```ts
// dsh-agent/lib/types/runtime-types.d.ts:193-200
/**
 * Submit steering for the nearest step. An idle driver starts a turn;
 * a running driver consumes it at its next step boundary.
 * A rejected step leaves steering parked in the inbox until the next
 * wake; cancellation or disposal may discard pending steering.
 */
steer(message: UserMessage): void;
```

Implementation is a synchronous inbox insert plus wake:
`steer(input) { this.send(input, "next-step", true); }`
(`dsh-agent-loop/lib/index.js:792-794`), and `send` is
`this.inbox.splice(resolvedTarget, Infinity, 0, [message]); if (wakeup) this.wakeDriver(...)`
(`:783-788`).

It returns `void` — **it is not a promise and there is no "delivered" signal.**
The loop claims the inbox only at `preStep` (`dsh-agent-loop/lib/index.js:889`,
`this.inbox.claim(target, position.turn)`).

### 3.2 `agent/turn-stopping` contract

```ts
// dsh-agent/lib/types/runtime-types.d.ts:396-400 — @mode serial
'agent/turn-stopping'(this: Scoped<Agent>, payload: {
    agent: Agent; turn: number; signal: AbortSignal;
}): Promise<void> | void;
```

Doc (`:379-395`) verbatim:

> "The turn is about to close: the model owes no response (no live tool calls, no
> fresh steering). **Awaited before the boundary commits** — a listener that
> objects steers (`agent.steer(...)`) and the machine re-reads its inbox: **fresh
> steering runs another step**, none closes the turn. Data decides, so listener
> order cannot change the outcome. The inverse control (stop a tool loop early)
> is data too: a tool result carrying `concludesTurn` ends the turn at its step.
> The conclusion never short-circuits already-submitted next-step work: same-step
> `additionalContexts` or racing steering still runs, and the turn closes only
> when that inbox drains."

Code confirms both halves:

- **Awaited**: `await this.dispatch.serial("agent/turn-stopping", { turn, signal });`
  (`dsh-agent-loop/lib/index.js:967-970`).
- **Can cause another step**: the *only* exit from the step loop is
  `if (turnEnds && this.inbox.nextStep.length === 0) break;`
  (`dsh-agent-loop/lib/index.js:973`) — and the hook is itself guarded by
  `if (turnEnds && this.inbox.nextStep.length === 0)` (`:966`), i.e. it fires
  exactly at the prospective stop boundary and a steer deposited inside it is
  re-read one line later.
- `concludesTurn` is the inverse lever: `ToolRunContext.concludeTurn()`
  (`dsh-tools/lib/types/index.d.ts:292-300`) sets
  `ToolExecutionSuccess.concludesTurn?: true` (`:399`), consumed at
  `dsh-agent-loop/lib/index.js:579` (`concluded ||= result.concludesTurn === true`).

### 3.3 Restriction on steering from inside a `session/event` callback

There is **no prose warning** naming `session/event` + `steer` in any `.d.ts`;
grep for `reentran`/`non-reentrant` across `$DSH/node_modules/@deepseek-ai/`
turns up only unrelated hits. The restriction is **enforced mechanically** in the
Session append path:

```js
// dsh-session/lib/index.js:1181
if (entry?.appending) throw new Error("session append cannot reenter while another append is being published");
```

and documented on `Session.append`:

> "A synchronous internal dispatch validation failure or **an append reentered
> while this acceptance/publication boundary is open also rejects before the log
> changes**." — `dsh-session/lib/types/index.d.ts:234-236`

`session/event` is emitted *post-commit, inside that boundary*, synchronously:
`this.log.push(event)` at `dsh-session/lib/index.js:1200`, then
`invokeContainedSessionObservers(entry.emitCtx, "session/event", ...)` at `:1202`,
with `entry.appending` still `true` until the `finally` at `:1204-1209`.

So: a `session/event` listener that synchronously triggers anything which appends
(the loop's next append, or a steer that wakes the driver into an append) risks
the guard above. **INFERENCE (strong, code-grounded)**: the safe pattern is to
defer — record a fact in the listener and act from `agent/pre-step`,
`agent/turn-stopping`, or `tools/post-execute`, which run outside the append
boundary. That matches this repo's own AGENTS.md rule.

### 3.4 `createUserMessage` and the required `source`

```ts
// dsh-llm/lib/types/message.d.ts:180-183
export declare function createUserMessage<T extends NewUserMessage>(
  input: T & { readonly id?: never; readonly role?: never }
): T & Pick<UserMessage, 'id' | 'role'>;
```

`NewUserMessage = Omit<UserMessage, 'id' | 'role'>` (`:155`), so `content` **and**
`source` are required. `MessageSource` is merge-extensible
(`message.d.ts:94-118`); the built-in `plugin` variant is:

```ts
plugin: { kind: 'plugin'; plugin: string } & ContextFormed
// message.d.ts:98-101
```

`ContextFormed` (`:71-89`) makes a producer declare what the context *is*:
`form?: 'instructions' | 'catalog' | 'snapshot' | 'relay' | 'recall' | 'notice'`.
A `'notice'` form additionally requires `summary: string` (`:81-85`), bounded to
`CONTEXT_SUMMARY_MAX_CHARS = 120` (`:110`, helper `boundContextSummary` `:116`).
The vocabulary is explicitly **semantic, never visual**: *"Colors, icons,
ordering, and collapse defaults are the consumer's business and must not enter
this union."* (`:35-40`).

Real examples:

```js
// dsh-hooks-codex/lib/index.js:113-115
const PLUGIN_SOURCE = { kind: "plugin", plugin: "hooks-codex" };

// dsh-repeat-tool-reminder/lib/index.js:1483-1493
createUserMessage({
  content: [{ type: "text", text: ... }],
  source: { ...PLUGIN_SOURCE, form: "notice", summary: `${exec.name} × ${count}` }
})
```

---

## 4. System prompt (question 4)

### 4.1 `section()` signature and semantics

```ts
// dsh-system-prompt/lib/types/index.d.ts:47-68
export interface PromptSection {
    readonly name: string;                                   // unique per layer
    readonly order: number;                                  // ascending; ties break on name code-unit order
    readonly text: string | ((context: AssembleContext) => string);
    readonly complete?: boolean;                             // treat as the WHOLE prompt
}

// dsh-system-prompt/lib/types/index.d.ts:233
section(section: PromptSection): () => void;                 // returns the Cordis effect disposer

// dsh-system-prompt/lib/types/index.d.ts:239
getSectionOrder(name: PromptSectionOrderName): number;

// dsh-system-prompt/lib/types/index.d.ts:252
context(context: PromptContext): () => void;                 // dynamic runtime context

// dsh-system-prompt/lib/types/index.d.ts:267,276,286
tools(provider): () => void;
variable(name: string, provider): () => void;
assemble(context?: AssembleContext): Promise<PromptAssembly>;
```

Ordering (`index.d.ts:50-54`): *"Sections are concatenated in ascending order.
Equal orders use code-unit name order."* Non-finite orders throw
(`dsh-system-prompt/lib/index.js:239`). Scoped sections **shadow** globals with
the same name, and duplicates within one layer throw
(`index.d.ts:226-229`, `lib/index.js:238-241`).

### 4.2 Exported order constants

`SECTION_ORDERS` is one frozen table (`dsh-system-prompt/lib/types/index.d.ts:109-141`;
identical literal at `dsh-system-prompt/lib/index.js:10-42`; `CONTEXT_ORDERS` at
`index.js:43-47`, resolved by `getSectionOrder`/`getContextOrder` at
`index.js:247-257`). Exported names and
values:

| name | value |
|---|---|
| `HARNESS_IDENTITY` | -1000 |
| `DEPLOYMENT_PERSONA_PREFIX` | 0 |
| `PLAN_POLICY` | 500 |
| `TEAM_POLICY` | 600 |
| `PTC_ONLY` | 800 |
| `FILE_REFERENCE` | 900 |
| `TOOL_BASH` | 1000 |
| `TOOL_PWSH` | 1010 |
| `TOOL_READ` | 1100 |
| `TOOL_WRITE` | 1200 |
| `TOOL_EDIT` | 1300 |
| `TOOL_GLOB` | 1400 |
| `TOOL_GREP` | 1500 |
| `TOOL_JOBS` | 1600 |
| `TOOL_PTY` | 1700 |
| `TOOL_WEB_SEARCH` | 2000 |
| `TOOL_WEB_FETCH` | 2100 |
| `TOOL_LSP` | 2200 |
| `TOOL_SESSION_QUERY` | 2300 |
| `TOOL_GOAL` | 2400 |
| `TOOL_CORDIS` | 2500 |
| `TOOL_WORKFLOW` | 2600 |
| `TOOL_RALPH` | 2700 |
| `TOOL_SUBAGENT` | 2800 |
| `TOOL_REPORT` | 2900 |
| `TOOLS_SDK` | 5000 |
| `DELIVERABLE_FILE_REFERENCES` | 9000 |
| `STRUCTURED_OUTPUT` | 9900 |
| `HARNESS_SOURCE` | 10000 |
| **`WEB_SURFACE`** | **10100** |
| **`DEPLOYMENT_PERSONA_SUFFIX`** | **10200** |

`CONTEXT_ORDERS` (`index.d.ts:144-148`): `SANDBOX_POLICY: 110`,
`APPROVAL_POLICY: 115`, `SUBAGENT_DELEGATION: 120`.

Section-name constants: `PERSONA_PREFIX_SECTION = "deployment:persona-prefix"`
(`index.d.ts:157`), `PERSONA_SUFFIX_SECTION = "deployment:persona-suffix"`
(`:159`); `TOOL_ORDER_REST = "<unlisted-tools>"` (`:161`).

The two you named are registered first-party as:

```js
// dsh-web-app/lib/index.js:180-184 — the web-surface section
promptCtx.systemPrompt.section({
  name: "app:web-surface",
  order: promptCtx.systemPrompt.getSectionOrder("WEB_SURFACE"),
  text: () => webSurfacePrompt(localWebUrl(promptCtx))
});

// dsh-persona/lib/index.js:43-44 — the deployment persona suffix
name: PERSONA_SUFFIX_SECTION,
order: ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_SUFFIX"),
```

The harness registers identity + both persona slots itself at
`dsh-system-prompt/lib/index.js:213-227` (`HARNESS_IDENTITY` text
`"You are an AI agent powered by DeepSeek Harness."` at `:216`), gated by
`Config.includeHarnessIdentity` (`:200`).

### 4.3 Per-model / per-surface conditionality

Four distinct mechanisms exist; none is a "model id → section" switch.

1. **Per-scope (per-agent, incl. per-preset)** — the primary mechanism.
   `AssembleContext.scope?: ScopeKey` (`index.d.ts:37-45`) is passed to every
   `text` provider, so a section can branch on which agent is assembling. Scoped
   sections shadow global ones (`:226-229`). This is how an agent preset replaces
   the deployment persona — see the *agent-plane* example at
   `dsh-agent-presets/presets/standard/agent.cordis.yml:22-29` (`dsh-persona` with
   its own `prefix`/`suffix`).
2. **Per-surface** — implemented at *mount* time, not inside the section: the
   `dsh-web-app` row only registers `app:web-surface` when `config.surfaceContext`
   is on and the web server service exists (`dsh-web-app/lib/index.js:177-193`).
   **INFERENCE**: a "surface" is not a first-class prompt input; it is whichever
   plugin happens to be mounted.
3. **Per-model route** — `RequestContext.systemPromptUpdate`
   (`dsh-session/lib/types/types.d.ts:224-225`): `'in-history'` when the route
   reads the latest `system` message at any position as the effective prompt. The
   loop reconciles the rendered prompt with that capability via
   `SystemPromptProjection` + `SystemPromptDecisionInput.inHistory`
   (`dsh-agent-loop/lib/types/runtime-context.d.ts:18-47`). So the *placement*
   strategy varies per model, not the content.
4. **Expert assembly waterfall** — `'system-prompt/assemble'`
   (`index.d.ts:27`), `@mode waterfall`, "The returned value is authoritative",
   with the caveat that *"A registered complete section is restored after this
   waterfall, so listeners cannot add to or replace that scope's system prompt."*
   (`:19-22`) — i.e. `complete: true` outranks the waterfall.

Also relevant: `suppressRuntimeContext()` (`index.d.ts:259`) drops the dynamic
runtime-context snapshot for a scope without touching the services that enforce
those facts, and `Config.includeRuntimeContext` defaults true
(`lib/index.js:201`, `:228`).

---

## 5. Native user-question / approval tools (question 5)

### 5.1 Yes — `ask_user_question` ships

`dsh-tool-ask-user` registers exactly one tool named **`ask_user_question`**
(`dsh-tool-ask-user/lib/index.js:11` package name `"tool-ask-user"`; tool name at
`:16`; `const inject = ["tools", "userQuestions"]` at `:12`).
Schema location: `dsh-tool-ask-user/lib/index.js:18-65` (declaration) and
`:66-95` (output contract).

Parameter schema (`:18-65`):

```
questions: array (required) of {
  id:    string (required)  "Stable id for this question; echoed in the answer."
  question: string (required)
  header:   string (optional)  "Optional short heading … 'Confirm' or 'Choose Mode'."
  options:  array (optional) of { label: string (required), description?: string }
  multi_select: boolean (optional, default false)
}   // items are additionalProperties: true
```

Output (`:67-95`): `{ answers: [{ id: string, selected: string[], custom?: string }] }`,
rendered as `JSON.stringify(value)` text (`:91-94`).

Execution (`:96-112`) calls `ctx.userQuestions.ask({ questions, agent, signal })`;
the tool **pauses mid-turn** until a UI provider answers and then returns an
ordinary tool result (package doc, `dsh-tool-ask-user/lib/types/index.d.ts:1-5`).

Service contract `UserQuestionService.ask` (`dsh-user-questions/lib/types/index.d.ts:44`,
doc `:28-43`): only the exact live runtime root may ask a human
(`CALLER_NOT_LIVE`, `DELEGATED_CALLER`, `ASK_ABORTED` error codes at `:39-42`).
The UI answerer is composed on the Agent-scoped waterfall
`'user-questions/request'` (`dsh-user-questions/lib/types/types.d.ts:69-77`).

**This tool is not the same mechanism as approval.** It is a model-initiated
question; approval is a policy-initiated gate on a specific call.

### 5.2 How approval policy interacts with tool execution

- `tools/pre-execute` listeners return `{kind:'ask', reason?}`. The registry
  resolves it through `serviceAsk` (`dsh-tools/lib/index.js:3117-3121`,
  implementation `:3314-3365`).
- The seam is consumed **opportunistically**: `const approval = this.ctx.get("approval")`
  (`:3315`). Missing service → deny with *"requires approval (not yet supported)"*
  (`:3316-3322`). Agent-less execution → deny ("no agent to route it through",
  `:3323-3329`).
- Outcome mapping is one-to-one (`:3337-3364`): `allowed-once` → allow;
  `rejected` → deny "the user rejected tool …"; `cancelled` → deny + flag so
  caller cancellation can replace the outcome; `unavailable` → deny "no approval
  channel is available". **`allowed-once` is the only grant**
  (`dsh-user-approval/lib/types/index.d.ts:123`).
- Session policy is applied *before* any interactive answerer:
  `ApprovalPolicy = 'ask' | 'never'` (`dsh-user-approval/lib/types/index.d.ts:46`);
  `'never'` resolves every ask to `'rejected'` deterministically (`:40-45`).
  The effective-policy override is folded from durable `approval/policy` events
  (`:16-31`), and `setPolicy(agent, policy)` switches it live (`:108`).
- `ApprovalService.request` requires an **open turn** — an idle ask rejects before
  appending anything (`:109-127`), and every ask/outcome pair is logged
  (`approval/asked`, `approval/decided` in `KNOWN_SESSION_EVENT_TYPES`:
  `dsh-session/lib/types/known-event-types.js:24-25`).

Mounted in the audited install at `dsh-base/cordis.patch.yml:225`
(`dsh-user-approval`). Note that in *this* session approval prompts are disabled
by policy, so `ask` degrades to denial (consistent with `'unavailable'`).

---

## 6. First-party precedent: mid-turn nudges and hard blocks (question 6)

Five shipped plugins do exactly the kind of thing a progress policy wants.

### 6.1 `dsh-repeat-tool-reminder` — **the closest precedent** (mounted, active)

Mounted with live config at `dsh-base/cordis.patch.yml:418-423`:
`thresholds: [3, 5, 8]`, `argumentsPreviewChars: 500`.

- **Hooks:** `tools/post-execute` (`dsh-repeat-tool-reminder/lib/index.js:1495`),
  plus `agent/pre-step` to reset the per-agent chain on a genuine human message
  (`:1509-1512`).
- **Injects:** a pill-sourced `UserMessage` created with
  `createUserMessage({ content, source: { ...PLUGIN_SOURCE, form: "notice", summary: `${exec.name} × ${count}` } })`
  (`:1483-1493`), prepended to whatever downstream contexts exist
  (`prependContext`, `:1442-1444`).
- **Composes rather than replaces:** it calls `await next()` and then re-emits the
  downstream decision with its context prepended, handling both the `block` arm
  (`:1499-1503`) and the accept arm (`:1504-1507`).
- **Never hard-blocks.** It has no `guard()` and never returns `kind:'block'`
  itself — only the caller may; it just never drops the reminder.
- Counting deliberately includes *denied* calls (`:1463-1470`: "denied calls also
  flow through this waterfall … a model hammering a denied call is exactly the
  loop worth breaking").
- The two reminder texts are at `:1385` (gentle, first threshold) and
  `:1387-1390` (detailed, naming tool/count/arguments).

### 6.2 `dsh-hooks-codex` and `dsh-hooks-claude-code` — external hook bridges

`dsh-hooks-codex/lib/index.js`:

- `tools/pre-execute` → `{kind:'deny', reason}` when the external `PreToolUse` hook
  denies (`:232-244`) — a **hard block**.
- `tools/post-execute` → `{kind:'block', feedback, additionalContexts:[context]}`
  on `PostToolUse` deny, else prepends context to the downstream decision
  (`:245-271`).
- **`agent/turn-stopping` → `agent.steer(createUserMessage(...))`** to force
  another step when the external `Stop` hook objects (`:272-292`). This is the
  canonical first-party demonstration that a turn-stopping listener can legally
  cause another step.
- `agent/pre-step` can return `{kind:'reject'}` (`:223`) and otherwise appends its
  context to the entering messages (`:224-230`).

`dsh-hooks-claude-code/lib/index.js:279-289` is structurally identical for
`additionalContexts`.

### 6.3 `dsh-session-checkpoint-policy` — durability, fail-closed

Mounted at `dsh-base/cordis.patch.yml:388-390`. Hooks: `llm/stream`
(`dsh-session-checkpoint-policy/lib/index.js:61`), `tools/execute` (`:66`),
`agent/pre-step` (`:72`). Doc (`lib/types/index.d.ts:11-22`): *"Checkpoint
failures are fail-closed at the model and tool side-effect boundaries: the
downstream adapter or tool body is not invoked."* It injects no model-facing
text and does not deny tool calls — it aborts before side effects. It does **not**
append custom durable events. (This is the pattern this repo's AGENTS.md points
at for `session/event` + persistence.)

### 6.4 `dsh-spill-policy` — result transformer

Mounted at `dsh-base/cordis.patch.yml:383-386` (`maxInlineBytes: 50000`). Hooks
`tools/post-execute` (`dsh-spill-policy/lib/index.js:155`) and
`tools/ptc-dispatch-log` (`:173`). Returns
`{ kind: 'accept', content: replaced, ...additionalContexts }`
(`:165`, `:170`) — it **rewrites the model-facing content** rather than blocking,
and explicitly *"COMPOSES with other post-execute listeners"*
(`lib/index.js:62`). Never hard-blocks.

### 6.5 `dsh-fs-observation-policy` — the one true hard invariant

Mounted at `dsh-base/cordis.patch.yml:258`. Hooks `fs/write-intent`,
`fs/edit-intent`, `fs/observed`
(`dsh-fs-observation-policy/lib/index.js:90-92`). The waterfalls are declared at
`dsh-fs/lib/types/index.d.ts:28`, `:36-42`, `:52` — single-slot decisions where
*"the first listener that returns an intent owns the decision rather than
composing with peers"* (`:21-23`). The refusal is a throw, e.g.
`if (!owner || prior === void 0) throw new FsError(\`edit requires reading "${target.displayPath}" first\`, "FS_NOT_OBSERVED");`
(`dsh-fs-observation-policy/lib/index.js:67`; also `:68` for `FS_NOT_FOUND`).
This is a **filesystem-level** block, older and cheaper than a tool guard.

### 6.6 `dsh-agent-instructions` — per-step durable context projection

Hooks `session/event` (**only** to record which step ended, `:1263-1269`),
`agent/pre-step` (splices the composed workspace-context message into the entering
batch, `:1270-1288`), and `tools/result` (`:1289-1307`). It builds context with
`createUserMessage({ …, source: { kind: "plugin", …, form: "instructions" } })`
(`:767-791`, `:1169-1203`). It deliberately **does not steer** from the
`session/event` listener — it only mutates local state and acts at `pre-step`.
This is the strongest in-tree precedent for the "record in session/event, act at
a boundary" discipline.

### 6.7 `ctx.tools.guard()` usage

Only one first-party guard exists in the whole install:
`dsh-subagent-in-process-driver/lib/index.js:85` —

```js
childCtx.tools.guard((exec) => captured === void 0 && pending === void 0
  ? void 0
  : `structured output already recorded: the run is complete, so \`${exec.name}\` is not executed`);
```

It is **scope-local** (`childCtx`, i.e. one agent) and monotonic — precisely the
"hard invariant" shape AGENTS.md prescribes for `guard()`.

---

## 7. Commentary affordance in the client / UI (question 7)

### 7.1 There is no "commentary" concept anywhere

Grep for `commentary` across the entire install: **zero matches**. There is no
phase flag, no `kind: 'interim'`, no semantic marking of progress text.

### 7.2 Mid-turn visible text *is* already surfaced

- Live streaming reaches the client as a client-only transient event
  `AssistantLiveChunkEvent { type: 'assistant/live-chunk'; seq; time; data: { attemptId, turn, step, chunk: StreamChunk } }`
  (`dsh-api-session-controller/lib/types/client/contract/events.d.ts:6-16`), which
  exists *outside* durable seq algebra (`:36-39`).
- Each durable attempt settles into `assistant/message` /
  `assistant/attempt`, and `MutableSessionEventSource.settleAssistant()` replaces
  the transient rows with the committed settlement
  (`events.d.ts:94-99`, `:51-54`).
- Server side, the same stream is published as the process-local event
  `agent/assistant-stream` (`dsh-agent/lib/types/runtime-types.d.ts:375-378`,
  emitted at `dsh-agent-loop/lib/index.js:1032`).

### 7.3 Something *does* collapse it — the "Turn process" disclosure

`dsh-client-ui-chat` groups earlier turn output behind a foldable "process" row
and shows only the finalized answer. The contract:

```ts
// dsh-client-ui-chat/lib/types/client/contract/chat-nodes.d.ts:84-95
/** Turn-level process disclosure projected before the finalized answer. */
export interface TurnProcessChatData {
    readonly turn: number;
    readonly controlAnchorSeq: number;
    readonly processStartSeq: number;
    readonly answerAnchorSeq: number | null;
    readonly answerStep: number | null;
    readonly inlineReasoning: boolean;
    readonly messageCount: number;      // "Reply-bearing durable Assistant messages before the final answer"
    readonly toolCallCount: number;
    readonly subagentCount: number;
}
```

Semantics at `contract/turn-process.d.ts:2-16`: `TurnProcessSpec` carries
`processStartSeq` / `answerAnchorSeq` / `answerStep`; the node kind
`'turn-process'` is documented as *"Turn-level disclosure controlling process
rows before the finalized answer"* (`conversation-nodes/turn-process.d.ts:5-8`).

**How the boundary is decided — this is the key evidence for question 2's
answer.** The client *heuristic* is:

```js
// dsh-client-ui-chat/lib/client.js:6748-6755
function isFinalAssistant(data) { return data?.finalNode !== void 0; }
function latestAnswer(turn) {
  const data = turn.steps.at(-1)?.data.get("assistant-step");
  if (!isFinalAssistant(data) || !hasAssistantReplyContent(data.blocks)) return null;
  return data.blocks.some((block) => block.kind === "tool-call") ? null : data;
}
```

i.e. **the last step's assistant message, provided it has reply content and no
tool-call blocks.** Messages in earlier steps (`messageCountByStep`,
`client.js:6789-6797`) and any message in a step that also called a tool are
folded into the process range (`processSpec`, `:6756-6786`).

Collapse behaviour:

- `processMember` = a node whose `anchorSeq` falls inside
  `[processStartSeq, answerAnchorSeq)` (`client.js:1556`).
- `foldable` requires the process window to be ready **and**
  `compactTranscript` (`client.js:1559` with `:1555`); this is the transcript view
  mode — `const compactTranscript = useTranscriptView((mode) => mode === "compact");`
  (`client.js:2086`).
- Hidden rows are hidden from search too: `processHidden = controllerInactive || foldable && processMember && !processOpen;`
  (`client.js:1573`), fed to `useSearchableHidden` (`:1574`).
- When folded, non-answer assistant rows are also visually compacted:
  `compactAnswer = processAnswer && foldable && processPresentation.compactAnswer && !processOpen`
  (`client.js:1572`).
- The collapsed label is a count summary — localization keys
  `message.turnProcess.toolCalls/messages/subagents` and
  `message.turnProcess.thoughtForAWhile` ("Thought for a while")
  at `client.js:2784-2791` (en) and `:2678-2685` (zh).
- Reasoning blocks get their own disclosure with `inlineReasoning`
  (`client.js:3065-3068`, `:4774-4787`).

**INFERENCE for the design decision:** mid-turn text is already *visible while it
streams*, and already *systematically de-emphasised after the fact* in the
compact transcript view — but only when the client can identify a "finalized
answer". If the model emits progress prose and then keeps calling tools, that
prose lands in the folded process range and the user may see only the summary.
Pushing more mid-turn text therefore does not automatically increase perceived
reporting frequency; interleaving text *between* tool calls in one step is more
visible than text at the end of a step.

There is also a durable, non-collapsed channel for context rows:
`ContextFormed` `'notice'` rows render a one-line `summary` on a collapsed row
(`dsh-client-ui-chat/lib/client.js:646`, `:755-770`, `:848-865`). A plugin-sourced
`UserMessage` with `form:'notice'` + `summary` is presented as a bounded
collapsed row rather than full prose.

---

## 8. Runtime observability (question 8)

Everything below is a real, readable signal; none of it is a bespoke "progress"
API.

### 8.1 Agent-level events (host plane, Cordis)

| event | mode | signature / source |
|---|---|---|
| `agent/status` | emit | `{ agent, status: 'idle' \| 'running' }` — `dsh-agent/lib/types/runtime-types.d.ts:247-250`; **emitted** at `dsh-agent-loop/lib/index.js:781` only on change |
| `agent/assistant-stream` | emit | `{ agent, frame: AssistantStreamFrame }` — `runtime-types.d.ts:375-378`; emitted `dsh-agent-loop/lib/index.js:1032` |
| `agent/inbox/inserted` / `claimed` / `discarded` | emit | `runtime-types.d.ts:258-261`, `:272-276`, `:284-287` |
| `agent/session-start` | emit | `{ agent, source: 'startup'\|'resume'\|'clear'\|'compact' }` — `:298-301` |
| `agent/pre-step` | waterfall | `{ agent, messages, turn, step, signal }` → `PreStepDecision` — `:313-319` |
| `agent/request` | waterfall | `{ agent, turn, step, signal }` → `LlmCallConfig` — `:336-341` |
| `agent/request-error` | waterfall | `:357-365` |
| `agent/turn-stopping` | serial | `:396-400` (see §3) |
| `agent/error` | emit | `{ agent, turn, step, error }` — `:411-416` |

`AssistantStreamFrame` (`runtime-types.d.ts:107-137`) is the fine-grained progress
signal: `{type:'start'|'chunk'|'end'}`; a `'chunk'` carries `{ attemptId, revision,
index, time, chunk: StreamChunk }` with *"Dense zero-based position within the
attempt"* (`:118-122`). `StreamChunk` variants are
`block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish`
(`dsh-llm/lib/types/types.d.ts:359-385`). A `'usage'` chunk and the terminal
`'finish'` are therefore available **live**, mid-attempt.

### 8.2 Durable evidence already in the log

- `step/start`, `step/end`, `turn/start`, `turn/end` give a complete position
  lattice (`types.d.ts:249-273`).
- `ToolUsage`/token accounting rides `assistant/message.usage?: TokenUsage`
  (`types.d.ts:315`) — *"the model output and its accounting travel together
  (there is no separate usage record)"* (`:300-307`).
- `assistant/attempt` preserves failed/retried/cancelled attempts
  (`:318-327`), i.e. retry counts are recoverable.
- `llm/retry` and `llm/retry-started` are durable types
  (`known-event-types.js:42-43`).

### 8.3 Services a plugin can *read*

- `ctx.tokenMeter.measure(session, requestHeader?)` → detached immutable
  `TokenMeasurement` (pressure + surface)
  (`dsh-token-meter/lib/types/index.d.ts:46`, doc `:25-45`);
  `estimateMessage(message)` at `:57`.
- Per-turn metrics are *derived* client-side from the durable tail:
  `ttftMs`, `tokensPerSecond`, `tokenUsage` on the turn-tail node
  (`dsh-client-ui-chat/lib/types/client/contract/chat-nodes.d.ts:75-82`, computed
  at `client.js:7202-7213` via `deriveTurnMetrics` / `deriveTurnTokenUsage`).
- `dsh-session-projection` / `dsh-session-query` / `dsh-session-turn-outline`
  expose whole-log folds (turn outline: turn number, `turn/start` seq, bounded
  prompt preview — `dsh-session-turn-outline/lib/types/index.d.ts:1-8`).
- `dsh-time-context` and `dsh-session-stats` exist as services (`lib/types/`
  present); not read in detail for this audit.

### 8.4 What does *not* exist

- **No** `agent/step` event and **no** `'progress'` event anywhere in the host
  packages. (`'progress'` appears once, in an unrelated package:
  `dsh-client-file-upload/lib/types/client/runtime.d.ts:27`.) Step boundaries are
  observed only as durable `step/start` / `step/end` via `session/event`, or as
  `agent/pre-step`.
- No elapsed-time/busy event; `agent/status` plus the `time` field on every durable
  event is all there is. **INFERENCE**: a progress plugin must compute elapsed time
  itself from `turn/start`/`step/start` timestamps.

---

## 9. Blocking-tool limitation (question 9)

**Confirmed.** No listener can inject a model-visible message while a single
long-running tool body is executing; enforcement can only act at an observable
boundary. The chain of evidence:

1. The tool body is awaited to quiescence:
   `const returned = await tool.execute(exec.arguments, exec);`
   (`dsh-tools/lib/index.js:3192`). The registry explicitly does **not** abandon
   it: *"Cancellation never abandons the body: a started promise reaches
   quiescence before its outcome becomes `ABORTED`"* (`:3171-3174`, `:746-750`).
   `ToolDefinition.execute` is documented as *"settle only after its owned work
   reaches quiescence"* (`dsh-tools/lib/types/index.d.ts:110-114`).
2. `dispatchScheduledExecution` wraps that await in the `tools/execute` waterfall
   and returns a settled result (`dsh-tools/lib/index.js:3209-3232`) — there is no
   yield point exposed to plugins between "call started" and "call settled" other
   than `agent/assistant-stream`-style *observation*.
3. The loop holds the group open until every started call settles:
   `while (inFlight.size > 0) { const settledIndex = await Promise.race(inFlight.values()); … }`
   (`dsh-agent-loop/lib/index.js:638-646`). Tool results and contexts are only
   committed in `commitReady()` (`:571-582`).
4. The step function itself awaits the entire tool-call group before it returns:
   `const { concluded } = await executeToolCalls(...)` (`dsh-agent-loop/lib/index.js:1118`).
   Only after that does `turn()` loop back to `preStep`, which is the sole place
   the inbox is claimed (`:937`, `:889`).
5. Therefore `agent.steer()` inside a long tool call only *queues*: `send()`
   splices into the inbox synchronously (`:783-788`) but nothing reads it until the
   next `preStep`. `agent.inject()` is even weaker — `send(input, "next-step", false)`,
   no wake (`:795-797`), doc `runtime-types.d.ts:201-209`.
6. `additionalContexts` are equally deferred: they are collected in
   `commitReady()` (which runs only after a call settles, `:571-582`) and pushed
   into the next-step inbox by the `acceptContext` callback (`:1118`). They affect
   the *next* request, never the in-flight one.

Corollary for the design decision: **the only enforceable cadence is per tool
call / per step.** A guard or post-execute policy can refuse the *next* call, and
a turn-stopping listener can refuse to stop, but neither can interrupt or
annotate work that is already running. **INFERENCE**: "report progress more often"
must be expressed as a condition on the *boundary* (e.g. "after N steps with no
text-bearing assistant message, or when a tool returns, attach a nudge"), which is
exactly the shape `dsh-repeat-tool-reminder` already implements.

---

## 10. Summary table for the design decision

| capability | extension point | hard-enforced? |
|---|---|---|
| deny one tool call, monotonically | `ctx.tools.guard(exec => string \| undefined)` — `dsh-tools/lib/types/index.d.ts:489,620` | **yes**, monotonic, cannot be un-denied |
| deny/ask before dispatch | `tools/pre-execute` waterfall `:38` | yes (deny/ask); `ask` fails closed |
| soft nudge the model | `tools/post-execute` → `PostToolDecision.additionalContexts` `:436,441,445` | no — advisory text, next step only |
| rewrite a tool result | `tools/post-execute` accept with `content`/`value` `:432-446` | effectively yes (model sees the replacement) |
| refuse to end the turn (force another step) | `agent/turn-stopping` + `agent.steer()` — `runtime-types.d.ts:379-400`, `dsh-agent-loop/lib/index.js:966-973` | **yes** — awaited, and the inbox is re-read |
| queue context for the next step | `agent.inject()` / `agent.steer()` — `:193-209` | no |
| durable fact observed by policy | `session/event` (emit, post-commit) `dsh-session/lib/types/index.d.ts:62` | observation only; **no appending from the callback** (`dsh-session/lib/index.js:1181`) |
| durable fact written by policy | `Session.append` + `ignorable` marker (out-of-tree types are outside `KNOWN_SESSION_EVENT_TYPES`, `known-event-types.js:8-20`) | reader refuses unknown non-ignorable types |
| prompt-level instruction | `ctx.systemPrompt.section({name, order, text})` `dsh-system-prompt/lib/types/index.d.ts:233` | static per assembly, not a runtime nudge |
| ask the human a structured question mid-turn | tool `ask_user_question` — `dsh-tool-ask-user/lib/index.js:16-65` | pauses the turn until answered |
| require a human decision before a call | `{kind:'ask'}` + `ApprovalService` — `dsh-tools/lib/index.js:3314-3365` | fail-closed; `allowed-once` only grant |
| interrupt work already running | — | **does not exist** (§9) |
| ask "is this text interim or final?" | — | **does not exist** (§2.3, §7.1) |

### Gaps / absences worth recording

- No `commentary`, `interim`, `phase`, or progress-semantics vocabulary anywhere
  in the installed build.
- No `agent/step` and no `'progress'` event.
- No allow-capable guard; `guard()` is deny-only by construction.
- No mechanism to reach inside a running tool call.
- The deployment's installer (`0.1.5-rc.1`) is one rc patch behind every audited
  package (`0.1.5-rc.2`).
