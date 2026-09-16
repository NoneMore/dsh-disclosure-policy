# Derive disclosure from runtime facts instead of compelling the model

Status: superseded by ADR-0003 (2026-09-16)

"Disclose more, but do not coerce the model" is only self-contradictory if disclosure can come from one source. We decided that it has two: the runtime derives facts from execution events that already exist and discloses them itself, while the model continues to supply the semantics — what was found, why the approach changed, what comes next. The runtime's disclosures are not a fallback for a lazy model; they are the part of the picture the model cannot be trusted to volunteer and, unlike model prose, cannot be withheld.

## Considered options

- **Prompt policy alone** (a standing instruction plus a soft reminder). Rejected: DSH's own measurements show a model can ignore a standing instruction for dozens of calls, and Codex's prompt-only cadence is the subject of open complaints in *both* directions — too insistent for users who asked for quiet monitoring, not insistent enough for users who wanted it suppressed. Prompt text is where the semantics belong; it is not where the guarantee belongs.
- **Carry live state in the system prompt itself**, via a dynamic `PromptSection.text` or `ctx.systemPrompt.variable()`. Rejected on inspected code, not on taste. The assembled prompt is a `system`-role entry *inside* `messages`, and `SystemPromptProjection` reacts to a changed rendering either by appending a **full copy of the entire system prompt** (the `in-history` route, which is what the base default model declares) or by rewriting node 0 in place (every other route, invalidating the prefix cache from token 0). `variable()` interpolates into section text and so sits on the same path. Per-step state also expires, which makes a standing prompt the wrong place for it on its own terms.
- **Model narration only, accepting that an uncooperative model yields a blind supervisor.** Rejected: it removes coercion at the cost of the thing coercion was introduced for. Supervision requires that silence be observable.

## Consequences

- **Cadence is bounded by call and step boundaries.** Nothing in DSH can inject during a single long tool call — tool execution is awaited and the step holds the whole call group open. Facts about a slow tool are therefore retrospective ("last command ran 2.1 s"), and wall-clock silence cannot be a trigger. This is recorded as a limitation rather than papered over with a timer that would fire too late.
- **Live state travels through `tools/post-execute` → `additionalContexts`**, which appends a next-step message and structurally cannot touch the cached prefix. This also aligns the plugin with the shipped first-party `dsh-repeat-tool-reminder`.
- **There is no human-only channel in the host.** Everything logged is model-visible, so runtime facts are seen by the model too. The fact row and the imperative reminder differ in tone and purpose, not in visibility.
- **The plugin must not become the model's ghostwriter.** Because `additionalContexts` reaches the model as well as the human, a runtime that narrated on the model's behalf would let the model free-ride. This is why the prototype measures the ratio of runtime-derived facts to model narration: it is the metric that would catch this failure.
