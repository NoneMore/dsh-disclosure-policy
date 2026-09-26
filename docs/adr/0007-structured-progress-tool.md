# Make disclosure a structured progress tool

Status: accepted (2026-09-26)

A real exported session showed that model-authored Assistant prose is the wrong protocol primitive for an interim supervision checkpoint. The disclosure reminder caused the model to emit only the required four-line progress text, the provider returned `stop`, and DSH correctly closed the turn. The failure was not a deadlock: the protocol gave one Assistant message two incompatible meanings — "interim progress" and "a response that may terminate the turn".

## Decision

Disclosure is now the structured model action `disclose_progress({ done, next, approach })`.

The tool arguments are the disclosure. A successful invocation opens a new disclosure interval. Runtime accounting no longer inspects Assistant prose and no `agent/turn-stopping` repair is used.

This works in both tool presentation modes:

- **native:** `disclose_progress` is a normal model tool call;
- **PTC:** it is a generated SDK binding and may run as a nested dispatch. DSH's conversation tool UI projects PTC dispatch children, so the supervisor can still inspect the atomic progress call even though the nested result is not inserted into model history as a separate tool result.

The progress primitive remains model-authored. The runtime does not synthesize `done`, `next`, or `approach`, score their quality, or inspect private reasoning.

## Context-budget rules

The redesign is a replacement, not an additive layer.

- The plugin installs **no standing system-prompt section**.
- The tool has one short description and exactly three required string fields: `done`, `next`, and `approach`.
- Parameter descriptions are intentionally omitted; the field names and tool description carry the contract.
- A successful tool result has canonical value `null` and renders **zero model-facing content blocks**, avoiding an echo of text the model already authored in the call arguments.
- Runtime reminders contain no four-line template or prose-format instructions; they only name `disclose_progress` and ask the model to continue.
- Activity context remains conditional and is shortened to one factual sentence.
- `deferLoading` is not used. Current DSH retains explicitly deferred baseline tools until a later retained addition activates them, while PTC still pays generated-SDK cost. For this always-available control primitive, reliability is more important than that provider-dependent optimization.

Tests enforce byte/character ceilings for the fixed description/reminder surface and inspect the registered schema so accidental descriptive bloat fails CI.

## Runtime accounting

One turn-local interval stores:

- completed top-level non-disclosure calls;
- reminder cadence/budget state;
- the rolling activity window;
- the current Assistant step and the step that already received a reminder.

`disclose_progress` resets only reminder accounting. It does not enter the activity window and does not itself advance cadence. Recent activity remains available across checkpoints.

Nested ordinary tool calls still affect activity but not cadence. A nested `disclose_progress` call resets the interval, so PTC mode has the same semantic behavior as native mode.

## Parallel-step bound

The previous implementation claimed that one parallel model step could deliver at most one reminder, but it tracked only completed-call count. A sufficiently large fan-out could cross several cadence periods in one step and spend several reminder slots before the model saw the first notice.

The adapter now records `assistant/message.data.step` only as execution identity. It does **not** inspect the message text. At most one reminder may be delivered for a model step; additional overdue cadence periods remain pending for a later step.

## Why not keep the stop-boundary repair

A one-shot `agent/turn-stopping` steer repairs one observed symptom but leaves the ambiguous protocol intact. It also creates a false-positive extra step for a legitimate completion/blocker disclosure and requires causal bookkeeping around a response that should never have represented progress in the first place.

The tool primitive removes that ambiguity upstream: progress is a tool action, final prose is final prose.

## Compatibility

The exported `hasVisibleText()` and `isModelDisclosure()` helpers remain in `./policy` as deprecated compatibility utilities, but the host plugin no longer calls them. Likewise the historical prompt-order constants remain exported for API compatibility; the plugin does not mount a prompt section.

## Residual limits

- Tool declarations still consume fixed request context. The schema is therefore intentionally minimal and tested for size.
- In PTC mode the declaration contributes to generated SDK text; there is no zero-cost model-visible primitive.
- The supervisor sees the structured call through tool presentation rather than ordinary Assistant prose. A specialized client card can improve presentation later without changing the runtime protocol.
- The plugin still cannot inject while one long tool call is running; reminders arrive only at call/step boundaries.
- The runtime verifies structure, not semantic quality. The model can still submit vague or false field values.
