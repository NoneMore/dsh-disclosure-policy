# DSH plugin + human-interaction practices

Research snapshot: 2026-09-16. Detailed provenance lives in `SOURCES.md`.

## 1. Separate three concerns

A long-running coding agent has at least three different state/control lanes:

1. **Plan/task accounting** — structured state such as DSH `todo_write`.
2. **Progress narration** — concise visible Assistant text telling a human what materially changed and what is next.
3. **Control** — Queue, Steer, Ask/approval, Stop.

Trying to make TODO state double as progress narration produces stale dashboards; trying to make narration double as control produces chatty but still uninterruptible runs. Keep the lanes separate and link them through runtime policy.

## 2. Use semantic reporting policy + numeric failsafe

Codex's public prompt uses meaningful work transitions rather than “every N tools” as the normal reason to report. That is the better interaction model. However, DSH community measurements show a model can ignore even explicit TODO instructions for dozens of calls. A practical DSH plugin should therefore combine:

- a standing semantic obligation (“report important phase completion, discovery, plan change, test result, blocker, next action”);
- a soft N-call reminder;
- a later hard checkpoint so the run cannot stay silent forever.

The hard threshold is a safety net, not the desired cadence.

## 3. Prefer native Assistant output over synthetic chat UI

DSH already logs `assistant/message` and the Web UI treats earlier reply-bearing Assistant messages as process material inside the same Turn. Let the model use that channel. Plugin-generated context should request narration; it should not forge an Assistant message on the model's behalf.

This has useful consequences: provenance remains correct, the normal Turn folding logic works, and the human can steer in response to a real model statement.

## 4. Runtime observability should not depend on model compliance

Even a good narration policy can fail or go quiet during a single long blocking tool call. Community `progress-viz` and long-tool UI reports point to a second layer: derive **stage / elapsed / current tool / stale counters / waiting state** from runtime events without consuming model tokens.

A future client surface for this plugin should display, at minimum:

```text
TODO: 3/7 completed · 5 calls since update
Progress: 9 calls since visible update
Current: bash / running 00:42
Control: Queue | Steer | Stop
```

That is more dependable than exposing chain-of-thought.

## 5. Use the narrow DSH extension point

Current official guidance maps cleanly:

- `session/event`: observe committed facts and maintain a live projection;
- `ctx.tools.guard()`: final monotonic hard invariant;
- `tools/post-execute.additionalContexts`: soft logged model-facing nudge;
- `ctx.systemPrompt.section()`: standing behavioral obligation;
- `agent/turn-stopping`: bounded objection before closing a Turn.

Do not poll deprecated Session history readers for live state.

## 6. Keep optional services optional

Cordis `inject` is a hard dependency. If a plugin can operate without a capability, omit it from `inject` and probe with `ctx.get()`. This is why v0.2 requires `tools` but merely enhances behavior when `systemPrompt` is installed.

Avoid ad-hoc “required/optional inject object” conventions unless the current framework documentation explicitly supports them.

## 7. Steering has lifecycle limits

`Agent.steer()` is nearest-step, not arbitrary preemption. A running agent consumes steering at a later step boundary. Community reports show a long blocking `job_output(wait: true)` can delay that boundary substantially.

Therefore “the Agent sends progress updates” is not equivalent to “the user can always interrupt immediately.” For highly interactive workloads, avoid giant blocking steps or add an explicit cancel/preempt path.

Also avoid synchronous `steer()` inside `session/event`; Session publication is non-reentrant. The official `agent/turn-stopping` hook is the clean place for this plugin's final reconciliation continuation.

## 8. Distinguish Ask aside from Steer

Community Side Chat/side-task plugins capture an important UX distinction:

- **Ask aside:** “Why did you choose this?” — curiosity, should not mutate the main run.
- **Steer:** “Stop doing A; switch to B.” — modifies the active run.

A mature UI should expose both, plus explicit approval/checkpoint and Stop.

## 9. Notify on blockers; narrate on meaning

Approval requests, sandbox denial, waiting-for-user, checkpoint-required, failure, and completion deserve strong UI attention. Ordinary progress updates should be low-frequency and information-dense. Community blocker notification plugins demonstrate the first half; Codex-style progress policy demonstrates the second.

Do not solve “Agent looks offline” by making it say “still working” every few commands.

## 10. Do not infer task completion from Turn completion

A Turn ending only proves that the model stopped owing immediate work according to the loop. It does not prove every external objective, test, deployment, or TODO succeeded. This is why the stop hook asks the model to reconcile state and why the runtime never silently changes TODO statuses.

## 11. PTC / Code Mode accounting

Count actual nested native dispatches instead of only outer `run_code`, otherwise a single transport call can hide a large amount of work. But keep the outer transport reachable so the system does not deadlock itself.

Human-interaction tools inside generated code have an additional risk: the code path must propagate the answer back to the model. Prefer top-level blocking questions for important decisions unless the PTC propagation path has been tested.

## 12. Plugin compatibility practices

- Pin/declare the DSH line you developed against.
- Ship prebuilt host output when possible so local installation is not blocked on git build-script permission.
- Run a real Web/headless boot test before publishing a release; pure policy tests cannot catch service/version seams.
- Start host-only when the feature does not require browser UI. A client bundle adds another registration/failure surface.
- Keep source links and dates in the repo. DSH is moving quickly enough that “this worked last month” is not a compatibility contract.
- Be cautious with custom persisted event types. If you only need live policy state, prefer plugin-local projections until you have intentionally handled unknown-event/ignorable compatibility.

## 13. Recommended next iteration after v0.2

Rather than lowering thresholds and increasing chatter, add **value-based triggers** while preserving the N-call backstop. Candidate high-value triggers: a TODO phase changes, a test changes from failing to passing, a major hypothesis is falsified, the implementation plan changes, a blocker appears, or another expected long-latency phase is about to start.

Then add a thin client projection for stale counters and checkpoint state. Keep the transcript focused on decisions and progress, and keep raw execution status in UI/runtime telemetry.
## 14. Codex comparison: use the layered pattern, not one magic threshold

The current Codex public repository makes the interaction architecture clearer than the older single-prompt comparison suggested. Multiple model instruction templates explicitly separate `commentary` from `final`, several current templates add a roughly 60-second maximum-silence expectation during active work, and persistent-mode metadata introduces async user messaging so “tell the user something” does not necessarily mean “end the turn.” At the same time, Codex issues show why these should not become inflexible rules: a fixed cadence can conflict with a user asking for quiet monitoring, and some downstream transports have historically lost commentary/final phase fidelity.

For DSH, copy the **layering** instead: semantic progress narration, structured TODO state, a configurable liveness fallback, explicit decision/approval paths, and a self-contained final answer. See `CODEX-PRACTICES.md` for the full source map and DSH portability matrix.

