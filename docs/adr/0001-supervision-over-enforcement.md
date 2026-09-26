# Replace tool-call enforcement with supervision

Status: accepted (2026-09-16), clarified by [ADR-0007](0007-structured-progress-tool.md) (2026-09-26)

The premise of this plugin is a division of labour: the task and its design/constraints are settled before execution, and the human's job during execution is to observe and decide whether to intervene. v0.2.x served that premise with enforcement — soft reminders, then a monotonic `ctx.tools.guard()` denial of the next ordinary tool call. We are removing tool-call enforcement entirely: the plugin registers no guard, never denies a tool call, and never rewrites task state. ADR-0007 later replaces Assistant-text disclosure with the structured `disclose_progress` tool; it does not restore tool denial. The reason is that enforcement corrects the model's *style*, which was never the failure; the failure was the supervisor's **blindness**, and a denial does not cure blindness — it only makes the model talk. OpenAI Codex, the design this plugin originally imitated, likewise has no runtime enforcement of commentary at all: its cadence lives in prompt text with no watchdog behind it.

## Considered options

- **Keep the hard checkpoint as a disabled-by-default escape hatch.** Rejected: a guard that is off by default is still a guard, and it would be re-enabled the first time the model went quiet — which is precisely the reflex this decision exists to break.
- **Escalate to a human approval instead of denying the model.** Rejected: it removes coercion of the model only by relocating the interruption onto the human, and it converts an informational problem into a decision the runtime is demanding.
- **Keep the guard for TODO truthfulness, where the state really is an invariant.** Rejected: TODO freshness is native task accounting, not model-authored disclosure. Version 0.3 narrows this plugin to disclosure instead of preserving a second policy lane.

## Consequences

- A sufficiently uncooperative model can stay silent for an entire turn. This is accepted: disclosure is best-effort rather than a runtime guarantee.
- The supervisor absorbs the risk that a reminder is ignored. The plugin states the model's obligation and sends at most one soft reminder per silence interval.
- The runtime does not narrate on the model's behalf. See [ADR-0003](0003-model-authored-disclosure.md), which supersedes the earlier runtime-derived design.
- The plugin has no hard invariant requiring `ctx.tools.guard()` and therefore registers no guard.
