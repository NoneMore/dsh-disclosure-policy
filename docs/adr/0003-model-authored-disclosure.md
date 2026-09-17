# Keep disclosure model-authored and best-effort

Status: accepted (2026-09-16), partly superseded by [ADR-0004](0004-bounded-repeat-reminders.md) (2026-09-17)

The plugin asks the model to disclose enough information for a supervisor to choose whether to intervene, but it does not generate disclosure from runtime facts or guarantee that disclosure occurs. A static policy states the semantic obligation and a single soft reminder may reinforce it; neither tool denial nor forced continuation is used. This deliberately accepts that an uncooperative model may remain silent in exchange for a substantially smaller, more auditable policy surface.

## Consequences

- Runtime events may decide when to send a reminder, but their contents are not presented as disclosure.
- The caller, not the plugin, supplies an execution brief: a sufficiently settled goal, boundary, design, constraints, and verification method.
- The plugin does not discover or validate the execution brief and does not negotiate it during execution unless the model cannot continue.
- TODO freshness is outside this plugin's responsibility; native task state remains separate from disclosure.
- The plugin does not force another model step when a turn is stopping. Final-answer quality remains a model-policy concern.
- Any non-empty visible model text resets the silence counter; the runtime does not score semantic quality.
- The only behavioral option is `reminderAfterCalls` (default `8`, `0` disables reminders while retaining the standing policy).
- Version 0.3 is a host-only plugin named `dsh-disclosure-policy`; it has no client component, facts-only experiment, or workspace metrics log.
- Each uninterrupted silence interval receives at most one reminder. Only a later non-empty visible model message opens a new interval. (Superseded by [ADR-0004](0004-bounded-repeat-reminders.md): an interval now receives a bounded cadence of reminders instead.)
- The counter includes only tool calls requested directly by the model; nested calls inside composite tools do not count separately.
- No opening preamble is required. The policy asks for concise disclosure at material findings, phase completion, direction changes, verification results, blockers, and before clearly long work.
- A reminder asks for what is now known, whether the settled plan or constraints changed, and what comes next or warrants intervention. It never requests private reasoning.
- Silence state is isolated per session turn and resets at `turn/start`; hot reload restarts from newly observed events rather than scanning history.
- Completed top-level calls count regardless of success or another policy's denial, while one parallel step can inject at most one reminder.
- Acceptance is behavioral: policy text, reset/count/reminder semantics, disabled reminders, and the absence of guards, TODO mutation, or turn-stop steering are covered by tests and the repository's required checks.
