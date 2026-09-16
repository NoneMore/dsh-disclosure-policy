# Volatile system-prompt text, request shape, and prompt caching in DSH

Audit of the **installed** tree:

* **Tree root (`$P`)** — `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
* **Installer meta-package** — `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\package.json` → `@deepseek-ai/dsh` **0.1.5-rc.1**

Every path below is relative to `$P` unless stated otherwise. Claims read directly from the
tree are cited as `path:line`. Anything I derived rather than read is marked **INFERENCE**.

The three "known starting points" from the earlier audit were re-verified and all three hold;
see §1–§3.

---

## 0. Versions of every package cited (question 8)

All from each package's own `package.json` `version` field.

| package | version |
|---|---|
| `@deepseek-ai/dsh` (installer, parent dir) | 0.1.5-rc.1 |
| `dsh-llm` | 0.1.5-rc.2 |
| `dsh-llm-deepseek` | 0.1.5-rc.2 |
| `dsh-llm-pi-ai` | 0.1.5-rc.2 |
| `dsh-system-prompt` | 0.1.5-rc.2 |
| `dsh-session` | 0.1.5-rc.2 |
| `dsh-agent` | 0.1.5-rc.2 |
| `dsh-agent-loop` | 0.1.5-rc.2 |
| `dsh-tools` | 0.1.5-rc.2 |
| `dsh-token-meter` | 0.1.5-rc.2 |
| `dsh-compaction-basic` | 0.1.5-rc.2 |
| `dsh-agent-instructions` | 0.1.5-rc.2 |
| `dsh-tmux-context` | 0.1.5-rc.2 |
| `dsh-sandbox-policy` | 0.1.5-rc.2 |
| `dsh-user-approval` | 0.1.5-rc.2 |
| `dsh-repeat-tool-reminder` | 0.1.5-rc.2 |
| `dsh-plan-mode` | 0.1.5-rc.2 |
| `dsh-client-ui-chat` | 0.1.5-rc.2 |
| `dsh-base` (composition only) | 0.1.5-rc.2 |

---

## 1. Where the assembled system prompt actually goes in a model request (question 1)

**Answer: as leading (and, later, non-leading) `system`-role entries inside the request's
`messages` array. It is not a separate provider `system` field on a loop-built request. Both
mechanisms exist in the type system; only the in-`messages` form is used by the agent loop.**

### 1.1 The type has both, and documents which one the loop uses

`dsh-llm/lib/types/types.d.ts:404-444` declares the request:

```
404: export interface GenerateOptions {
406:     provider: string;
407:     model: string;
...
410:     /**
411:      * Ordered conversation messages, exactly as the provider sees them. A
412:      * loop-built request passes the derived history (dsh-agent-loop), whose
413:      * leading system-role message carries the system prompt; a hand-built
414:      * one-shot passes any list.
415:      */
416:     messages: Message[];
417:     /**
418:      * System prompt text for one-shot callers; adapters map it to the provider's
419:      * system slot ahead of `messages`. Loop-built requests leave it undefined.
420:      */
421:     system?: string;
```

`dsh-llm/lib/types/message.d.ts:139-147` declares the in-history carrier:

```
139:  * A system-role specialization of the one shared message representation: one
140:  * rendered system prompt attributed to the plugin that assembled it. Empty
141:  * `content` means "no system prompt" and projects to no wire message.
144: export interface SystemMessage extends Message {
145:     readonly role: 'system';
146:     readonly source: MessageSourceMap['plugin'];
```

### 1.2 The construction site

`dsh-agent-loop/lib/index.js:1166-1218` is the only place the loop builds the request:

```
1204: 		const boundaryMessages = session.deriveMessages();
...
1211: 		return markAgentLoopRequest(Object.freeze({
1212: 			...header.config,
1213: 			messages: boundaryMessages,
1214: 			...header.tools !== void 0 ? { tools: header.tools } : {},
1215: 			sessionId: this.session.id,
1216: 			signal
1217: 		}));
```

`header.config` is a `LlmCallConfig`, and `dsh-llm/lib/types/call-config.d.ts:16-23` shows it has
exactly `provider`, `model`, `reasoningEffort`, `temperature`, `maxTokens`, `stop` — **no
`system` field**. So `options.system` is never set by the loop. Corroborated by
`dsh-session/lib/types/surface.js:130-131`, which rejects a header carrying one:

```
130:         if (Object.hasOwn(header, 'system'))
131:             throw new Error(`${subject} must omit header.system; use system/message`);
```

and by the package docs, `dsh-system-prompt/README.md:135`: *"The rendered prompt reaches the
model as a system-role message of derived history — surface node 0, or the latest system node
after an in-history update — neither the loop request nor `request/header` carries a separate
`system` field."*

### 1.3 How the prompt becomes a `messages` entry

1. **Assembly.** `dsh-agent-loop/lib/index.js:890`
   `const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));`
   — this runs **once per step**, inside `preStep` (`:885-908`).
2. **Rendering.** `dsh-agent-loop/lib/index.js:1014` `const renderedPrompt = renderPrompt(assembly);`
   `renderPrompt` is `dsh-system-prompt/lib/index.js:111-113`: interpolate `{{var}}`, drop empty
   sections, join with `"\n\n"`.
3. **Projection to a surface node.** `dsh-agent-loop/lib/index.js:1019-1027` calls
   `this.systemPrompt.project(renderedPrompt, {...})` and commits each returned commit as a
   `system/message` session event (see §3).
4. **Derivation to messages.** The committed `system/message` events are surface nodes;
   `session.deriveMessages()` folds them into `Message[]` via the pure per-node rule in
   `dsh-session/lib/types/surface.js:75-110` (`case 'system/message'` at `:96-101` returns
   `event.data.message`, or `null` for empty content).

So the observable request is `messages: [ {role:'system',…}, {role:'user',…}, …, {role:'system',…}, … ]`.

### 1.4 What the adapters do on the wire

**DeepSeek adapter** (`dsh-llm-deepseek/lib/index.js`): system-role messages are serialized
**in place**, not lifted to a top-level field —

```
134: function serializeMessages(messages) {
138: 		if (message.role === "system") {
139: 			wire.push({
140: 				role: "system",
141: 				content: flattenText(message.content)
142: 			});
143: 			continue;
```

(same at `:188-195` for the image path). The one-shot `options.system`, if present, is prepended
as a leading system message: `:258-266` and `:276-298`.

**pi-ai adapter** (`dsh-llm-pi-ai/lib/index.js`) is the opposite: it lifts only the **leading**
system message into the provider's system slot and converts every *later* system message into a
plain `user` message —

```
1205: function splitSystemPrompt(options) {
1210: 	const [first, ...rest] = options.messages;
1211: 	if (first?.role !== "system") return { systemPrompt: void 0, messages: options.messages };
1215: 	const text = flattenText(first);
1216: 	return { systemPrompt: text.length > 0 ? text : void 0, messages: rest };
...
1242: 		if (message.role === "system") {
1243: 			messages.push({ role: "user", content: flattenText(message), timestamp: 0 });
1244: 			continue;
```

**INFERENCE:** this is why the projection (§3) *consolidates* into node 0 on routes that do not
declare `systemPromptUpdate: 'in-history'` — a later `system` message would otherwise be
silently demoted to a user message by pi-ai.

---

## 2. `systemPromptUpdate: 'in-history'` (question 2)

### 2.1 Full type declaration

`dsh-llm/lib/types/types.d.ts:313-319`:

```
313: /**
314:  * How a model applies a system prompt that changes mid-conversation.
315:  * `'in-history'`: the model reads the latest `system` message at any position
316:  * of `messages` as the complete effective system prompt, so a changed prompt
317:  * can follow the cached history instead of rewriting message 0.
318:  */
319: export type SystemPromptUpdate = 'in-history';
```

It is a **single-value union**. The documented absence case is at
`dsh-llm/lib/types/types.d.ts:328`: *"Declared mid-conversation system prompt handling; absent
means only a leading system message is read."*

Other allowed values: **none**. `dsh-llm/lib/index.js:2057-2058` rejects anything else:

```
2057: 			const systemPromptUpdate = resolved.systemPromptUpdate;
2058: 			if (systemPromptUpdate !== void 0 && systemPromptUpdate !== "in-history") throw new LlmError(`adapter returned invalid system prompt update mode for provider "${provider}" model "${model}"`, "INVALID_MODEL_INFO");
```

and the DeepSeek catalog schema pins it: `dsh-llm-deepseek/lib/index.js:1882`
`systemPromptUpdate: z.const("in-history")`, validated loudly at `:1931-1932`.

### 2.2 Who sets it

* **The adapter, from its model catalog.** `dsh-llm-deepseek/lib/index.js:1841-1871` — only
  **`deepseek-flash`** declares it (`:1849 systemPromptUpdate: "in-history"`). The other three
  shipped entries (`deepseek-v4-flash` `:1851-1856`, `deepseek-v4-pro` `:1857-1862`,
  `deepseek-v4-flash-vision-exp` `:1863-1870`) do **not**, so they are leading-system-only
  routes.
* **The default route in the base composition is `deepseek-flash`:**
  `dsh-base/cordis.patch.yml:75-79` (`provider: deepseek-official`, `model: deepseek-flash`).
  The Web app does not override it (`dsh-web-app/cordis.patch.yml` contains no
  `agent-default-model` row). The `llm-pi-ai` adapter (**INFERENCE**: and any other adapter)
  never sets `systemPromptUpdate` — grep for the identifier in `dsh-llm-pi-ai/lib/` returns
  nothing.
* **The LLM runtime propagates it** onto `LlmResolvedModelInfo` (`dsh-llm/lib/types/types.d.ts:329`)
  and onto `PreparedLlmCall` (`dsh-llm/lib/types/index.d.ts:100-101`).

### 2.3 The code path that honors it

`dsh-agent-loop/lib/index.js:1017-1022`:

```
1017: 			const { config, preparedCall } = await this.prepareRequest(turn, step, signal);
1018: 			const startsRequestSeries = firstAttempt && decision.startsRequestSeries === true;
1019: 			const commits = this.systemPrompt.project(renderedPrompt, {
1020: 				inHistory: preparedCall?.systemPromptUpdate === "in-history",
1021: 				startsSeries: startsRequestSeries || this.requestSurfaceGeneration !== this.session.surface.replaceGeneration || this.toolsChanged(assembly.tools)
1022: 			});
```

`inHistory` is consumed only by `SystemPromptProjection.project` (§3). It is **also logged** as
route metadata: `dsh-agent-loop/lib/index.js:1193-1201` writes a `request/context` event
(`provider`, `model`, `contextWindow`, `systemPromptUpdate`) whenever any of those differs from
the newest snapshot. The type is `dsh-session/lib/types/types.d.ts:216-226`:

```
224:     /** `'in-history'` when the route reads the latest `system` message at any position as the effective system prompt. */
225:     systemPromptUpdate?: SystemPromptUpdate;
```

### 2.4 Difference in observable request shape

| | route without `systemPromptUpdate` | route with `systemPromptUpdate: 'in-history'` |
|---|---|---|
| unchanged prompt | no commit at all (`project` returns `[]`) | no commit at all |
| changed prompt, continuing series | **node 0 rewritten in place** (`replace`), later non-empty system nodes emptied | **new `system` message appended at the tail** of the surface; earlier nodes untouched |
| wire shape | one system message, at position 0, always | possibly several `system` entries; the last non-empty one is effective |
| prefix-cache consequence | request differs from token 0 → whole prefix invalid | prefix through the pre-existing history unchanged → reusable |

Documented verbatim at `dsh-agent-loop/README.md:160` and `dsh-system-prompt/README.md:149`.

---

## 3. `SystemPromptProjection` (question 3)

Full declaration: `dsh-agent-loop/lib/types/runtime-context.d.ts:28-49`; implementation:
`dsh-agent-loop/lib/index.js:241-298`. It is constructed per loop instance at
`dsh-agent-loop/lib/index.js:771`.

**What it projects:** the fully rendered system prompt string onto the session's
**model-visible surface** — specifically the set of surviving `system/message` surface nodes —
and returns ordered per-node *updates* (it does not own the commit).

**From what:** `systemNodes()` (`:247-259`) walks `session.surface.nodes`, keeps
`event.type === 'system/message'` nodes, and records `{seq, text}` with `""` for empty content.
Input is the rendered string plus `SystemPromptDecisionInput` —
`dsh-agent-loop/lib/types/runtime-context.d.ts:18-27`:

```
18: export interface SystemPromptDecisionInput {
19:     /** Whether the prepared route for this attempt reads a later `system` message as the effective prompt. */
20:     inHistory: boolean;
21:     /**
22:      * Whether this step's request starts a new model-message series: a pre-step
23:      * listener declared one, the surface was replaced since the last request, or
24:      * the assembled tool schemas differ from the logged header.
25:      */
26:     startsSeries: boolean;
27: }
```

**When recomputed:** every step. `preStep` re-assembles (`:890`), `step` re-renders (`:1014`)
and re-projects (`:1019`) — so on every model request, and again on every retry attempt inside
`step`'s `while (true)` loop (`:1016`). The projection is stateful only in that it reads the
live surface each time; it holds no cache of its own.

**Does it append or mutate? — Both, chosen by route/series.** `dsh-agent-loop/lib/index.js:266-284`:

```
266: 	project(rendered, input) {
267: 		const nodes = this.systemNodes();
268: 		const head = nodes[0];
269: 		if (head === void 0) return [{
270: 			message: createSystemMessage(rendered, SOURCE),
271: 			intent: { surfaceOp: "append" }
272: 		}];
273: 		const latest = nodes.findLast((node) => node.text !== "") ?? head;
274: 		if (!input.inHistory || input.startsSeries || rendered.length === 0) {
275: 			const updates = nodes.slice(1).filter((node) => node.text !== "").map((node) => this.replace(node.seq, ""));
276: 			if (head.text !== rendered) updates.push(this.replace(head.seq, rendered));
277: 			return updates;
278: 		}
279: 		if (latest.text === rendered) return [];
280: 		return [{
281: 			message: createSystemMessage(rendered, SOURCE),
282: 			intent: { surfaceOp: "append" }
283: 		}];
284: 	}
```

Reading this literally:

* **No head yet** → append the first prompt as node 0 (note: this happens even when `rendered`
  is `""`, reserving node 0 — `runtime-context.d.ts:29-30`).
* **Consolidating branch** — when the route is *not* in-history, **or** a new series starts,
  **or** the rendering is empty → it **empties every later non-empty system node**
  (`this.replace(node.seq, "")`, `:275`) and then **mutates node 0 in place**
  (`this.replace(head.seq, rendered)`, `:276`). `replace` (`:285-297`) emits
  `{surfaceOp: {op:'replace', startSeq, endSeq}, sourceEventSeqs:[seq]}`.
* **Append-only branch** — in-history + continuing series + non-empty rendering → if
  `latest.text === rendered`, **no commit at all**; otherwise it **appends a brand-new
  `system` message containing the entire rendered prompt** (`:281`). Earlier system nodes are
  left in place.

**Key consequence (read, not inferred):** the append-only branch is *not* a diff. It re-appends
the **whole rendered prompt**, not the changed fragment. The loop's own README states the cost
at `dsh-agent-loop/README.md:156`: *"on an `in-history` route every retained prompt version is
paid until compaction shadows it or prompt reconciliation empties it."*

Surface legality of the in-place rewrite is enforced by
`dsh-session/lib/types/surface.js:331-340` (`assertSystemHeadRewrite`), and a replacement bumps
`replaceGeneration` (`:376`). The `system/message` event contract is documented at
`dsh-session/lib/types/types.d.ts:282-298`.

**Related: `RuntimeContextProjection`** (`dsh-agent-loop/lib/index.js:300-356`) is the sibling
that turns dynamic *contexts* into user-role messages, and it is deliberately
change-suppressed — `:336-339`:

```
336: 	project(current, sections) {
337: 		if (this.retained === void 0 && current.length === 0) return;
338: 		const snapshot = current.length === 0 ? CLEARED : current;
339: 		if (this.retained?.text === snapshot) return;
```

---

## 4. Caching — every real hit (question 4)

### 4.1 Wire / usage mapping (real)

| where | what |
|---|---|
| `dsh-llm-deepseek/lib/index.js:1145-1166` | `mapUsage()` reads `usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens` (`:1155`) and emits `cacheReadTokens` (`:1163`), subtracting cache reads out of `inputTokens` (`:1160`) because "DeepSeek's `prompt_tokens` INCLUDES cache hits" (`:1146-1149`). |
| `dsh-llm-deepseek/lib/types/types.d.ts:151-165` | Wire fields: `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `prompt_tokens_details.cached_tokens`. |
| `dsh-llm/lib/types/types.d.ts:128-150` | Harness `TokenUsage` with `cacheReadTokens?` (`:147`) and `cacheWriteTokens?` (`:148`). Doc: *"Adapters whose providers fold cache hits into a total prompt count (DeepSeek's `prompt_tokens`) subtract them out."* |
| `dsh-llm-pi-ai/lib/index.js:1363` | `...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}` — the only place `cacheWriteTokens` is ever set by an adapter. The DeepSeek adapter never sets it. |
| `dsh-client-connection/lib/client.js:2345-2352` | `fixtureUsage()` — **not production**; a deterministic *test fixture* ("Deterministic provider billing attached to fixture assistant messages"). Listed only to dismiss it. |

### 4.2 Cache-control / cache-retention request markers (real, but only in the pi-ai adapter)

* `dsh-llm-pi-ai/lib/types/config.d.ts:118-119` — `cacheRetention?: CacheRetention; // Prompt-cache retention preference`, passed through to the SDK at `dsh-llm-pi-ai/lib/index.js:1666`.
* `dsh-llm-pi-ai/lib/types/catalog.d.ts:209-219` — capability gates `cacheControlFormat` ("Prompt-cache marker convention; `openai-completions`"), `supportsLongCacheRetention`, `supportsCacheControlOnTools` ("Whether the endpoint accepts `cache_control` on tool definitions; `anthropic-messages`").
* Scheme offers at `dsh-llm-pi-ai/lib/index.js:397-398, 412, 435, 948-949`.

**No `cache_control` is ever written by the DeepSeek adapter, and neither adapter inserts an
explicit cache breakpoint into `messages`.** Grep for `cache_control` / `ephemeral` across the
whole tree returns only the pi-ai capability-gate declarations above (plus unrelated
sandbox-`/tmp` and frontend hits). So there is **no DSH-side cache-marker construction at all**;
DeepSeek relies on its provider-side automatic prefix caching.

`dsh-session-projection-cache` is **not** a prompt cache — it is a persisted *session projection*
write-behind store (`dsh-base/cordis.patch.yml:158-166`). Listed to dismiss it.

### 4.3 Places that deliberately keep a stable prefix (real)

1. **The in-history append path itself** — `dsh-agent-loop/lib/index.js:279-283` exists solely to
   avoid rewriting node 0. Design intent stated at `runtime-context.d.ts:28-35`: *"A capable
   continuing series appends changed nonempty text after the cached history."*
2. **`RuntimeContextProjection` change suppression** — `dsh-agent-loop/lib/index.js:339`
   (emit only when the snapshot text differs).
3. **Plan mode keeps the tool catalog fixed across modes** — `dsh-base/cordis.patch.yml:309`:
   *"The tool catalog stays the same across modes for request-cache stability. … those tools
   remain listed only to keep the request shape stable."* Implemented by `dsh-plan-mode` adding
   only a **prompt section** (`dsh-plan-mode/lib/index.js:170`), not a tool restriction.
4. **Fork subagents omit model selection so the inherited history stays cache-eligible** —
   `dsh-base/cordis.patch.yml:356-361`: *"Fork omits model selection so provider/model stay equal
   to the parent and the inherited history remains eligible for KV Cache reuse."*
5. **Compaction summarization replays the prefix and appends its instruction last** —
   `dsh-compaction-basic/lib/index.js:258-269`: *"replay the conversation prefix, then append the
   compaction instruction as the final user message so the provider's warm prefix cache is
   reused"*; implemented at `:282-291`.
6. **`LlmCallConfig` drift is logged rather than silently allowed** — `dsh-llm/lib/types/call-config.d.ts:1-7`:
   *"Provider routing, model, reasoning effort, and sampling values are request-header state that
   can affect cache reuse; request waterfalls replace them and the loop logs changed snapshots
   instead of allowing silent per-call drift."*

### 4.4 Places that *measure* cache hits (real)

* **Durable projection, per attempt and cumulative.** `dsh-token-meter` registers a
  `sessionProjections` unit keyed `"tokenUsage"` with `cacheReadTokens` / `cacheWriteTokens`
  buckets — `dsh-token-meter/lib/types/usage-projection.d.ts:57-66`; folding at
  `dsh-token-meter/lib/index.js:342-366`; prompt pressure counts cache traffic at `:389`.
* **Per-turn exact accounting.** `dsh-token-meter/lib/types/turn-usage.d.ts:8-22`:
  `TurnTokenUsage.cacheReadTokens?` / `cacheWriteTokens?` — *"Present only when every attempt
  reported the bucket."*
* **UI.** `dsh-client-ui-chat/lib/types/client/chat/token-format.d.ts:16-24`
  (`formatCacheHitPercent(cacheReadTokens, promptTokens, …)`), used at
  `dsh-client-ui-chat/lib/client.js:3492` and `:3934`.

So: **DSH does not implement provider-side caching itself; it assumes the provider caches the
prefix, is architected to avoid gratuitously breaking that prefix, and measures the provider's
reported cache hits.** The guarantee is explicitly disclaimed at
`dsh-system-prompt/README.md:149`: *"Any change may invalidate reuse from the first changed
token; provider cache sharing and measured hit rates are not guaranteed."*

---

## 5. Volatility cost for a `PromptSection.text` function (question 5)

**Setup.** `PromptSection` (`dsh-system-prompt/lib/types/index.d.ts:47-68`) allows
`text: string | ((context: AssembleContext) => string)` (`:60`) — *"a provider evaluated at each
assembly with that assembly's `AssembleContext`"*. It is called at
`dsh-system-prompt/lib/index.js:339`:

```
339: 					text: typeof section.text === "function" ? section.text(context) : section.text
```

Assembly runs **every step** (`dsh-agent-loop/lib/index.js:890`). So a function returning a
different string per call produces a different `renderPrompt` result on every step of the turn.

**What happens next is route-dependent.** Two cases, both read directly from
`dsh-agent-loop/lib/index.js:274-283`:

### Case A — route declares `systemPromptUpdate: 'in-history'` (default `deepseek-flash`)

* `inHistory` is `true` (`:1020`), `startsSeries` is normally `false` (`:1021`, provided tool
  schemas and the surface are unchanged).
* `latest.text !== rendered` → the projection **appends a new `system/message` containing the
  entire rendered prompt** (`:280-283`).
* **The cached prefix does not break.** The change lands at the *tail*: the new system node sits
  after everything already in the surface, immediately before this step's own user messages. The
  wire request is `[ …unchanged history…, {role:'system', <full new prompt>}, {role:'user',…} ]`.
* **But the cost is severe and compounding.** Every step adds one more full copy of the whole
  system prompt to history; earlier copies are never cleared in this branch. This is the
  documented cost at `dsh-agent-loop/README.md:156`. A per-step volatile section therefore turns
  the prompt into O(steps) repeated prompt text within one turn.

### Case B — route does **not** declare it (`deepseek-v4-pro`, `deepseek-v4-flash`,
`deepseek-v4-flash-vision-exp`, every pi-ai route)

* `!input.inHistory` is true → the consolidating branch runs:
  later non-empty system nodes are emptied (`:275`) and **node 0 is rewritten in place**
  (`:276`), tagged `replace` and bumping `surface.replaceGeneration`
  (`dsh-session/lib/types/surface.js:376`).
* **The cached prefix breaks from token 0.** `dsh-agent-loop/README.md:160`: *"A prompt change
  that replaces a system node in place makes the request differ from that node's first token —
  in full when the node is node 0."*
* A subsequent compaction or an explicitly declared series start also forces this branch, even on
  an in-history route (`:274`).

### Case C — same routes, but the change comes from `ctx.systemPrompt.variable()`

`variable()` providers are resolved into a `variables` map at
`dsh-system-prompt/lib/index.js:313-314` **before** `renderPrompt` interpolates them into section
text (`:111-113`, interpolation at `:151-175`). A volatile variable therefore changes the
rendered section text exactly as a volatile `text` function does, and lands in Case A or Case B
accordingly. **`variable()` is not a volatility-safe mechanism** — it writes into the prefix.

### What the source cannot answer

The source establishes the *request-shape* consequence (append vs. node-0 rewrite) with certainty.
It **cannot** establish the provider's actual cache-hit behaviour for a given prefix change, because
that is server-side. `dsh-llm-deepseek/README.md:163` says an unchanged prefix is "eligible for
DeepSeek cache reuse" and lists the things that "may prevent reuse" — hedged language, and
`dsh-system-prompt/README.md:149` explicitly disclaims measured hit rates.

**Tests that would settle it (all first-party, no code changes needed):**

1. **Request shape.** Run two consecutive steps in one turn with a volatile section, then read the
   session log: count `system/message` events and inspect their `surfaceOp`/`sourceEventSeqs`. A
   growing count of `append` nodes ⇒ Case A; a single node with `replace` metadata ⇒ Case B.
2. **Measured hits.** Read the `tokenUsage` session projection (`cacheReadTokens`,
   `cacheWriteTokens`) or `deriveTurnTokenUsage()` across those same two turns
   (`dsh-token-meter/lib/types/turn-usage.d.ts:8-32`) and compare against a control turn with a
   stable section on the same route. A drop in `cacheReadTokens` attributable to the volatile step
   is the direct measurement.
3. **Wire level.** Capture the outgoing request body via the `llm/stream` waterfall
   (`dsh-llm/lib/types/index.d.ts:45`) and diff consecutive bodies byte-for-byte.

---

## 6. Supported alternatives for volatile, per-step model-facing text (question 6)

For each: does it become a **new history message** or mutate the **prefix**, and is it **re-sent
every request**?

### 6.a `tools/post-execute` → `additionalContexts` — **append-only, new history messages**

* Type: `dsh-tools/lib/types/index.d.ts:389-412` — `additionalContexts?: UserMessage[]` on both
  success (`:397`) and failure (`:408`); `PostToolDecision` at `:428-446` allows attaching them on
  `accept` and on `block`. Doc at `:428-431`: *"accept, replace one projection, attach context for
  the next request, or block"*.
* Conveyance: the loop collects them at `dsh-agent-loop/lib/index.js:578`
  (`for (const context of result.additionalContexts ?? []) acceptContext(context);`) and the
  acceptor splices them into the **next-step inbox** at `:1118`:
  `(context) => this.inbox.splice("next-step", this.inbox.nextStep.length, 0, [context])`.
* They are claimed by the next `preStep` (`:889`) and committed as `user/message` events with
  `surfaceOp: "append"` (`:1028`).
* **Prefix:** untouched — appended after the step's tool results. **Re-sent:** yes, as ordinary
  durable history (`dsh-agent-loop/README.md:166,170`).
* Label them, or they read as a human prompt — `dsh-repeat-tool-reminder/lib/index.js:1372-1375`:
  *"the label is load-bearing (an unlabeled context would render as a user prompt in derived
  history)."*

### 6.b `agent/pre-step` — **append-only, new history messages**

* Event: `dsh-agent/lib/types/runtime-types.d.ts:302-319`. Decision type
  `PreStepDecision` at `:91-99` — `{kind:'enter', messages: UserMessage[], startsRequestSeries?: true}`.
* Runs **after** assembly (`dsh-agent-loop/lib/index.js:890` vs. the waterfall at `:894`), so it
  cannot change the prompt but can add messages.
* Returned messages are committed with `surfaceOp: "append"` at `dsh-agent-loop/lib/index.js:1028`.
* **Caveat:** `startsRequestSeries: true` (`:97-98`) deliberately forces the *consolidating*
  branch of `SystemPromptProjection` (`:274`), i.e. declaring a series is itself
  prefix-invalidating. Don't set it for a nudge.
* First-party users: `dsh-agent-instructions/lib/index.js:1270-1288` (workspace
  `<system-reminder>` messages), `dsh-tmux-context/lib/index.js:1510-1543`.

### 6.c `ctx.systemPrompt.context()` — **append-only, but only when the text changes**

* Signature `dsh-system-prompt/lib/types/index.d.ts:252`; type `PromptContext` at `:69-77`,
  documented as *"Dynamic model context materialized as a durable user-role snapshot."*
* Path: assembled every step (`dsh-system-prompt/lib/index.js:344-347` — the `text` function is
  called at `:346`, same as sections), rendered by `renderContextSnapshot` / `joinContextSections`
  (`:119-134`), then handed to `RuntimeContextProjection.project`
  (`dsh-agent-loop/lib/index.js:892-893`), which returns a `UserMessage` **only when the text
  differs** (`:339`), and that message is appended (`:1028`; pushed at `:900`).
* **Prefix:** untouched. **Re-sent:** yes — but the *message* is one-shot; later changes add
  further snapshots, and the joined text carries the disambiguator
  (`dsh-system-prompt/lib/index.js:133`):
  *"Current runtime context. This snapshot supersedes earlier runtime-context snapshots."*
* This is exactly where **first-party volatile policy** lives:
  `dsh-sandbox-policy/lib/index.js:121-130` (sandbox mode can change mid-session) and
  `dsh-user-approval/lib/index.js:79-89` (approval policy can change mid-session; the change is
  *also* announced by `agent.inject()` at `:102-111`).

### 6.d `ctx.systemPrompt.variable()` — **mutates the prefix. Not an alternative.**

* Signature `dsh-system-prompt/lib/types/index.d.ts:276`; resolved into the assembly's variable map
  at `dsh-system-prompt/lib/index.js:313-314` and interpolated into **section text**
  (`:111-113`, `:151-175`). See §5 Case C.
* **Prefix:** yes, it is part of the rendered system prompt. **Re-sent:** every request as prompt
  text.
* The loop's own uses are session-stable facts — `dsh-agent-loop/lib/index.js:1534-1536`
  registers `provider`, `model`, `cwd` — and `dsh-system-prompt/README.md:149` warns that persona
  changes and variable changes can alter the early prefix. **Do not use this for per-step state.**

### 6.e Also worth naming

* **`agent.inject(input: UserMessage)`** — `dsh-agent-loop/lib/types/agent.d.ts:43`,
  implemented at `:795-797` as `this.send(input, "next-step", false)`. Appends a user message to
  the next step's inbox without waking the driver. Used by `dsh-user-approval/lib/index.js:102-111`.
  Same append-only semantics as (b), minus the assembly-time hook.
* **`ctx.tools.guard()`** — `dsh-tools/lib/types/index.d.ts:610-620`: a *monotonic* denial check
  (`ToolGuard` at `:481-489`, returns a reason string to deny, `undefined` to allow). It carries
  **no model-facing text at all**; use it only for hard invariants, never for a nudge.

---

## 7. Recommendation for live-state policy text (question 7)

**Use `tools/post-execute` → `additionalContexts`, with a `source` labelled
`{kind: 'plugin', plugin: '<your-plugin>', form: 'notice', summary: '…'}`.**

Justification, all from source:

1. **It cannot touch the prefix.** The message enters through the next-step inbox
   (`dsh-agent-loop/lib/index.js:1118`) and is committed with `surfaceOp: "append"` (`:1028`).
   `SystemPromptProjection` never sees it, so §5's node-0-rewrite hazard is structurally
   impossible. First-party documentation of the result: `dsh-repeat-tool-reminder/README.md`,
   "KV Cache effect" — *"Append-only; newly visible content follows the reusable request prefix
   and does not invalidate existing KV-cache entries."*
2. **It is the shipped precedent for exactly this class of message.** `dsh-repeat-tool-reminder`
   is a threshold-triggered "you are looping, change approach" nudge delivered through
   `tools/post-execute` (`dsh-repeat-tool-reminder/lib/index.js:1495-1508`), constructed as a
   `createUserMessage` with `form: "notice"` (`:1483-1493`). "You have gone 7 tool calls without
   disclosing" is the same shape: a counter plus a threshold plus advisory prose.
3. **It costs nothing before the threshold.** No message is committed unless a listener returns
   one, so the steady state adds zero tokens and zero request-shape change.
4. **It is durable and reconstructable.** The message is a logged `user/message` with a labelled
   plugin source, so replay, compaction, and the transcript all keep it (`dsh-session/lib/types/types.d.ts:275-281`).
5. **`ctx.tools.guard()` is the wrong tool** — it produces no model-facing text
   (`dsh-tools/lib/types/index.d.ts:481-489`) and should stay reserved for monotonic invariants.

**Exact API call.** In an apply-scoped listener:

```js
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const NUDGE = "You have gone 7 tool calls without disclosing progress. Disclose what you have " +
  "actually established before the next tool call."

ctx.on('tools/post-execute', async (exec, result, next) => {
  const downstream = await next()
  if (!shouldNudge(exec)) return downstream

  const nudge = createUserMessage({
    content: [{ type: 'text', text: NUDGE }],
    source: {
      kind: 'plugin',
      plugin: 'todo-checkpoint-guard',
      form: 'notice',                       // ContextFormed; requires `summary` (message.d.ts:81-84)
      summary: '7 tool calls without a disclosure'
    }
  })

  // Preserve downstream contexts; both PostToolDecision variants accept the field.
  return { ...downstream, additionalContexts: [nudge, ...(downstream.additionalContexts ?? [])] }
})
```

Notes on the call, each sourced:

* `createUserMessage` is exported from `dsh-llm` (`dsh-llm/lib/types/message.d.ts:180-183`); the
  first-party `dsh-agent-instructions` imports it exactly that way
  (`dsh-agent-instructions/lib/index.js:2`).
* `form: 'notice'` requires the `summary` field — `dsh-llm/lib/types/message.d.ts:81-84`; `summary`
  is length-bounded by `boundContextSummary` (`:110-116`).
* Returning `{...downstream, additionalContexts: [...]}` is safe for both decision variants; the
  shipped reminder handles the `block` variant separately
  (`dsh-repeat-tool-reminder/lib/index.js:1499-1507`). Spreading works because `additionalContexts`
  is optional on both arms (`dsh-tools/lib/types/index.d.ts:432-446`).
* If the nudge is produced *per step* rather than per tool call, `agent/pre-step` with
  `{kind:'enter', messages: [...]}` is the equivalent channel
  (`dsh-agent/lib/types/runtime-types.d.ts:91-99`) — but **never** set `startsRequestSeries`.
* If the text is genuinely *policy that changes rarely* (e.g. "disclosure is currently required"),
  `ctx.systemPrompt.context()` is the right home — that is what sandbox and approval policy use
  (`dsh-sandbox-policy/lib/index.js:121-130`, `dsh-user-approval/lib/index.js:79-89`) — and it is
  change-suppressed (`dsh-agent-loop/lib/index.js:339`).
* **Do not** put the counter in `ctx.systemPrompt.section(...)` or
  `ctx.systemPrompt.variable(...)`. Both write into the prefix (§5 Case C); on
  `deepseek-flash` that appends a full copy of the entire system prompt every time the count
  changes; on every other shipped route it rewrites node 0 and invalidates the whole prefix.

---

## 8. Confidence and residual uncertainty

| claim | basis | confidence |
|---|---|---|
| Loop-built requests have no separate `system` field | `dsh-agent-loop/lib/index.js:1211-1217` + `call-config.d.ts:16-23` + `surface.js:130-131` | high |
| `systemPromptUpdate` is a one-value union, absent = leading-only | `dsh-llm/lib/types/types.d.ts:313-319` + `dsh-llm/lib/index.js:2057-2058` | high |
| Only `deepseek-flash` declares `in-history` by default | `dsh-llm-deepseek/lib/index.js:1841-1871` | high |
| In-history ⇒ append whole prompt; otherwise ⇒ rewrite node 0 | `dsh-agent-loop/lib/index.js:266-284` | high |
| Appending preserves the cached prefix; node-0 rewrite does not | README `agent-loop:160`, `system-prompt:149`, `llm-deepseek:163` + request-shape reasoning | high on shape, **unverifiable from source on provider hit rates** |
| `additionalContexts` arrive as next-step appended user messages | `dsh-agent-loop/lib/index.js:578, 1118, 1028` | high |
| `systemPrompt.context()` is change-suppressed and append-only | `dsh-agent-loop/lib/index.js:336-339`, `:892-893` | high |
| `variable()` writes into the prefix | `dsh-system-prompt/lib/index.js:313-314` + `:111-113` | high |

**Cannot determine from source:** whether a specific provider actually reuses the prefix after a
given change, and what the measured hit rate is. §5 lists the three tests that would answer it,
using only first-party surfaces (session log `system/message` events, the
`tokenUsage` projection / `deriveTurnTokenUsage()`, and the `llm/stream` waterfall).
