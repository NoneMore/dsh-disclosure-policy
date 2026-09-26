# Repeat the silence reminder within a bounded budget

Status: accepted (2026-09-17), partly superseded by [ADR-0005](0005-structural-disclosure-recognition.md) (2026-09-26; the cadence is retained, but structured disclosure replaces any-visible-text reset)

Version 0.3 latched the reminder with a `reminded` boolean, so each silence interval received exactly one reminder and an ignored reminder meant the rest of the interval was silent. That contradicted the plugin's own stated goal — "make silence unlikely to last" — because the latch was the most likely to fire precisely when the model was least willing to disclose. The reminder is now a bounded cadence instead of a one-shot: at most `maxReminders` notices (default `3`) per interval, one every `reminderAfterCalls` completed top-level calls, with `maxReminders: 1` restoring the historical behavior. A repeat carries the same request plus one fixed sentence, and never states how many reminders remain.

## Considered options

- **Keep the one-shot latch and document it as an accepted cost.** Rejected: ADR-0001 already accepted that an uncooperative model may stay silent, but that acceptance was about the *plugin* not compelling the model. It was never a reason to stop asking, and "one reminder per interval" quietly converted a best-effort nudge into a single-shot guarantee that fails in the one situation it exists for.
- **Escalate tone or add a hard gate.** Rejected for the same reason ADR-0001 removed enforcement: denial corrects the model's style, and the failure being addressed is the supervisor's blindness. A hard gate also re-opens the "make the model talk" failure mode — a model can satisfy a gate with a content-free message.
- **Tell the model its remaining budget.** Rejected: publishing the remaining count turns a prompt into a game the model can win by waiting the cadence out, and it hands the enforcement rule to the party being supervised.
- **Retrigger on a wall-clock timer.** Not available: nothing in DSH can inject during a single long tool call, so the cadence is bounded by call and step boundaries (ADR-0002 consequences).

## Consequences

- **A delivered reminder spends a budget slot; an attempted one does not.** A downstream `tools/post-execute` exception still advances the cadence but leaves the slot for the next boundary that can carry `additionalContexts`, so a throwing policy cannot silently consume the budget.
- **The interval, not the reminder, is the unit that resets.** Only visible model-authored text (or a new turn) opens a new interval and restores the full budget.
- **The budget is per turn.** `turn/end` discards the state, so a model that keeps opening fresh turns is not covered; this remains a documented limitation rather than a guarantee.
- **Any visible text satisfies the reset.** A one-word acknowledgement resets the interval exactly like a real disclosure, so the repeat cadence raises the cost of silence but not of evasion. The runtime still does not score semantic quality (ADR-0003), and the disclosure plugin still generates no disclosure of its own.
- **The reminder stays soft.** No guard, no denial, no steering, and no new extension point: the plugin still registers exactly `session/event` and `tools/post-execute`.
