# Replace the finite reminder budget with capped exponential backoff

Status: accepted (2026-09-26)

ADR-0004 fixed the one-shot reminder problem by allowing a bounded number of repeat reminders. That removed immediate silence after the first ignored notice, but the finite `maxReminders` budget introduced the same failure at a later point: after the last permitted notice, an indefinitely working model could remain silent forever until it voluntarily called `disclose_progress`.

The policy needs two properties at once:

1. reminder traffic must remain bounded enough that a long tool-heavy turn does not become a fixed-frequency stream of nagging context;
2. ignoring a finite number of notices must never disable supervision permanently.

## Decision

Replace the finite total reminder budget with **capped exponential backoff**.

Configuration becomes:

- `reminderAfterCalls` (default `8`): completed top-level ordinary calls before the first reminder; `0` disables runtime reminders;
- `maxReminderIntervalCalls` (default `64`): maximum spacing between later reminders. When reminders are enabled it must be at least `reminderAfterCalls`.

After each reminder that is actually delivered, the next interval doubles until the configured maximum spacing is reached. With defaults the interval lengths are:

```text
8, 16, 32, 64, 64, 64, ...
```

Therefore the idealized cumulative carrier counts are:

```text
8, 24, 56, 120, 184, 248, ...
```

There is **no total reminder count limit**.

The next interval anchors from the call count where the previous reminder was actually delivered. A reminder that is due but cannot be attached because downstream post-execute policy throws does not advance backoff. Likewise, same-step delivery fencing withholds extra notices without advancing backoff; the overdue notice may be attached on a later model step.

A successful `disclose_progress` opens a fresh disclosure interval and resets the reminder spacing to the initial `reminderAfterCalls` interval. Existing checkpoint-step sibling accounting and activity-window preservation remain unchanged.

## Why cap the interval instead of the count

A count cap has a terminal state: "never remind again in this interval." That terminal state is exactly the liveness failure the reminder lane exists to avoid.

An interval cap bounds long-run reminder **rate** instead. Once the maximum spacing is reached, token cost grows linearly at a low fixed rate rather than disappearing entirely. The model cannot permanently outwait a known finite number of reminders.

The default maximum of 64 top-level calls is intentionally conservative relative to the initial 8-call threshold: it permits three doublings before settling into the long-run cadence. This is a local policy choice, not a DSH contract, and remains configurable for real-use tuning.

## Rejected alternatives

- **Keep `maxReminders` but raise the default.** This only moves the silence boundary farther away.
- **Repeat forever at the original fixed interval.** This solves permanent silence but turns one ignored notice into constant prompt pressure during very long turns.
- **Unbounded exponential backoff.** It technically never stops, but intervals can grow so large that the practical behavior converges back toward silence.
- **Wall-clock reminders.** The plugin still cannot inject context during one blocking tool call; call/step boundaries remain the available delivery seam.
- **Publish the backoff index or next threshold to the model.** The supervisor does not benefit from giving the model an explicit countdown to the next intervention.

## Compatibility

`maxReminders` is removed from the current configuration surface. `reminderAfterCalls: 0` is now the single way to disable runtime reminders while keeping `disclose_progress` available.

ADR-0009 supersedes ADR-0004 only for current reminder cadence and budget semantics. ADR-0004 remains the historical record of why repeat reminders replaced the original one-shot latch.
