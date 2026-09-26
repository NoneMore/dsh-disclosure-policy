# DSH plugin + human-interaction practices

Research snapshot: 2026-09-16. Detailed provenance lives in `SOURCES.md`. Current local policy is ADR-0007 (2026-09-26): disclosure is the structured `disclose_progress` tool action; historical prose-based designs below are version-specific.

## 1. Separate three concerns

A long-running coding agent has at least three different state/control lanes:

1. **Plan/task accounting** — structured state such as DSH `todo_write`.
2. **Progress disclosure** — a concise structured model action telling a human what materially changed and what is next.
3. **Control** — Queue, Steer, Ask/approval, Stop.

Trying to make TODO state double as progress narration produces stale dashboards; trying to make narration double as control produces chatty but still uninterruptible runs. Keep the lanes separate and link them through runtime policy.

## 2. Use semantic reporting policy + numeric failsafe

Codex's public prompt uses meaningful work transitions rather than “every N tools” as the normal reason to report. That is the better interaction model. However, DSH community measurements show a model can ignore even explicit TODO instructions for dozens of calls. A practical DSH plugin should therefore combine:

- one compact always-available progress primitive whose description carries the semantic obligation;
- a soft N-call reminder.

The numeric threshold is a safety net, not the desired cadence. v0.2 added a third stage — a hard checkpoint that denied the next tool call — and v0.3 removed it: enforcement corrects the model's style, while the actual failure is the supervisor's blindness, and a denial does not cure blindness (ADR-0001). v0.4 also replaced the one-shot reminder latch with a bounded cadence: a single ignored reminder left the rest of the interval silent, which is the one situation the reminder exists for. The safety net now repeats up to `maxReminders` times, and after that it still stops — repeating a nudge indefinitely is how a liveness check turns into noise (§9).

## 3. Use an explicit progress primitive when the host lacks phase semantics

DSH can display reply-bearing Assistant material before the final answer, but visibility alone does not make that material non-terminal. A real session showed the model could emit a correct progress-only Assistant response and then legally end the Turn.

The current plugin therefore uses `disclose_progress({ done, next, approach })`. The model still authors the content, but progress is now an action inside the tool loop rather than prose whose lifecycle role must be inferred. Do not synthesize Assistant messages on the model's behalf.

## 4. Runtime observability should not depend on model compliance

Even a good narration policy can fail or go quiet during a single long blocking tool call. Community `progress-viz` and long-tool UI reports point to a second layer: derive **stage / elapsed / current tool / stale counters / waiting state** from runtime events without consuming model tokens.

A future client surface could display, at minimum:

```text
Disclosure: 9 completed calls since the last visible update · reminded at 8, 16
Current: bash / running 00:42
Control: Queue | Steer | Stop
```

That is more dependable than exposing chain-of-thought. `dsh-disclosure-policy` is host-only and ships
no such surface; the counters it keeps are plugin-local.

## 5. Use the narrow DSH extension point

Current official guidance maps cleanly:

- `ctx.tools.register(defineTool(...))`: structured model action;
- `session/event`: turn lifecycle and model-step identity;
- `tools/post-execute.additionalContexts`: soft logged model-facing nudge;
- `ctx.tools.guard()`: final monotonic hard invariant — not used here;
- `agent/turn-stopping`: bounded objection before close — not needed here.

`dsh-disclosure-policy` uses the first three only. It installs no standing prompt section, no guard, and no stop steering.

Do not poll deprecated Session history readers for live state.

## 6. Keep optional services optional

Cordis `inject` is a hard dependency. The current plugin requires only `tools`; it no longer depends on `systemPrompt`. Avoid ad-hoc “required/optional inject object” conventions unless the current framework documentation explicitly supports them.

## 7. Steering has lifecycle limits

`Agent.steer()` is nearest-step, not arbitrary preemption. A running agent consumes steering at a later step boundary. Community reports show a long blocking `job_output(wait: true)` can delay that boundary substantially.

Therefore “the Agent sends progress updates” is not equivalent to “the user can always interrupt immediately.” For highly interactive workloads, avoid giant blocking steps or add an explicit cancel/preempt path.

Also avoid synchronous `steer()` inside `session/event`; Session publication is non-reentrant. If a
plugin must object before a Turn closes, `agent/turn-stopping` is the documented boundary — but a
disclosure plugin does not need to object at all, and `dsh-disclosure-policy` performs no steering.

## 8. Distinguish Ask aside from Steer

Community Side Chat/side-task plugins capture an important UX distinction:

- **Ask aside:** “Why did you choose this?” — curiosity, should not mutate the main run.
- **Steer:** “Stop doing A; switch to B.” — modifies the active run.

A mature UI should expose both, plus explicit approval/checkpoint and Stop.

## 9. Notify on blockers; narrate on meaning

Approval requests, sandbox denial, waiting-for-user, checkpoint-required, failure, and completion deserve strong UI attention. Ordinary progress updates should be low-frequency and information-dense. Community blocker notification plugins demonstrate the first half; Codex-style progress policy demonstrates the second.

Do not solve “Agent looks offline” by making it say “still working” every few commands.

## 10. Do not infer task completion from Turn completion

A Turn ending only proves that the model stopped owing immediate work according to the loop. It does not prove every external objective, test, deployment, or TODO succeeded. Task state therefore stays native, and the runtime never silently changes it. `dsh-disclosure-policy` goes further and does not touch task state at all: disclosure and accounting are separate lanes with separate owners.

## 11. PTC / Code Mode accounting

Which calls to count is a policy choice, not a DSH fact. The current cadence counts **top-level ordinary** calls only (`exec.parent === undefined`), while nested native calls still enrich the activity window.

`disclose_progress` is different: a nested PTC invocation is itself the checkpoint and resets the interval. A successful checkpoint makes the whole Assistant step the boundary, so settlement order between the nested call and its enclosing `run_code` cannot change cadence semantics.

## 12. Plugin compatibility practices

- Pin/declare the DSH line you developed against.
- Ship prebuilt host output when possible so local installation is not blocked on git build-script permission.
- Run a real Web/headless boot test before publishing a release; pure policy tests cannot catch service/version seams.
- Start host-only when the feature does not require browser UI. A client bundle adds another registration/failure surface.
- Keep source links and dates in the repo. DSH is moving quickly enough that “this worked last month” is not a compatibility contract.
- Be cautious with custom persisted event types. If you only need live policy state, prefer plugin-local projections until you have intentionally handled unknown-event/ignorable compatibility.

## 13. Recommended next iteration after v0.4

The threshold remains a backstop, so the next honest improvement is not a lower number but a better
trigger. Candidate high-value triggers: a verification step changes from failing to passing, a major
hypothesis is falsified, the implementation plan changes, a blocker appears, or another expected
long-latency phase is about to start. DSH exposes none of these semantically today; a plugin would have
to derive them from durable events and accept the misclassification risk.

Two smaller, sharper steps are now visible from the shipped behavior rather than from theory:

- **Close the cross-turn gap.** Intervals are turn-local, so a model that keeps opening fresh turns
  resets its own budget and can stay effectively silent without ever hitting the cadence. This is the
  remaining structural hole in the reminder lane.
- **Make the cadence observable to the supervisor.** The counter and the spent budget are plugin-local;
  a thin client projection would let the supervisor see staleness without waiting for model prose. That
  is also the only mechanism that does not depend on the model cooperating.

## 14. Codex comparison: use the layered pattern, not one magic threshold

The current Codex public repository makes the interaction architecture clearer than the older single-prompt comparison suggested. Multiple model instruction templates explicitly separate `commentary` from `final`, several current templates add a roughly 60-second maximum-silence expectation during active work, and persistent-mode metadata introduces async user messaging so “tell the user something” does not necessarily mean “end the turn.” At the same time, Codex issues show why these should not become inflexible rules: a fixed cadence can conflict with a user asking for quiet monitoring, and some downstream transports have historically lost commentary/final phase fidelity.

For DSH, copy the **layering** instead: semantic progress narration, structured TODO state, a configurable liveness fallback, explicit decision/approval paths, and a self-contained final answer. See `CODEX-PRACTICES.md` for the full source map and DSH portability matrix.

