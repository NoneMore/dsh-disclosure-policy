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
- The tool has one short description and exactly three required string fields: `done`, `next`, and `approach`. The one-line description retains the old semantic moments—findings, phase/plan shifts, checks, blockers, and long work—without restoring a separate standing prompt. The executor rejects whitespace-only values before resetting accounting; this preserves the old non-empty contract without adding parameter-description/schema tokens.
- Parameter descriptions are intentionally omitted; the field names and tool description carry the contract.
- A successful tool result has canonical value `null` and renders **zero model-facing content blocks**, avoiding an echo of text the model already authored in the call arguments.
- The tool explicitly opts into parallel scheduling with `isConcurrencySafe: () => true`. DSH treats an omitted classifier as **exclusive**, so leaving it undefined would add a serial barrier around every checkpoint.
- The description/reminder tells the model to issue the checkpoint alongside the next work tool(s) when work remains, avoiding an extra model round-trip in the common case.
- Runtime reminders contain no four-line template or prose-format instructions; they only name `disclose_progress` and ask the model to continue.
- Activity context remains conditional and is shortened to one factual sentence.
- `deferLoading` is not used. Current DSH retains explicitly deferred baseline tools until a later retained addition activates them, while unsupported routes fall back to active declarations and PTC still pays generated-SDK cost. Dynamically adding/removing this tool would also create tool-update history and cache churn. For this tiny always-available control primitive, a fixed compact schema is the lower-risk overhead trade.

Tests enforce byte/character ceilings for the fixed description/reminder surface and inspect the registered schema so accidental descriptive bloat fails CI.

## Runtime accounting

One turn-local interval stores:

- completed top-level non-disclosure calls;
- reminder cadence/budget state;
- the rolling activity window;
- the current Assistant step;
- completed top-level ordinary calls observed in that current step;
- the step that already received a reminder; and
- a direct progress attempt known from that Assistant message.

`disclose_progress` resets only reminder accounting. It does not enter the activity window and does not itself advance cadence. Recent activity remains available across checkpoints.

A successful checkpoint resets the previous interval, but it does **not** exempt ordinary sibling work in the same Assistant step. Top-level non-disclosure calls that already settled in that step are carried across the reset into the fresh interval; top-level siblings that settle afterwards continue advancing the fresh counter. In PTC mode this includes the enclosing `run_code` when it later settles. This keeps accounting independent of parallel settlement order without turning a checkpoint-plus-fan-out step into a cadence blind spot. Reminder delivery remains fenced for the rest of that model step.

For a direct native progress call, the committed Assistant message identifies the pending tool call before dispatch. Due reminders are withheld for that step until the attempt settles: success resets accounting; failure leaves the overdue reminder available on the next model step. This prevents a stale reminder from racing a parallel progress attempt.

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
