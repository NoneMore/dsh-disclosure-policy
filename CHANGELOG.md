# Changelog

## 0.3.0

- Renamed the package, patch row, and plugin id to `dsh-disclosure-policy` / `disclosure-policy`. The repository directory is unchanged.
- Replaced the two enforcement lanes (TODO freshness and communication freshness) with one best-effort disclosure policy: a static prompt section plus at most one soft reminder per silence interval. See ADR-0001 and ADR-0003.
- Removed `ctx.tools.guard()` entirely: the plugin no longer denies a tool call. Removed the `agent/turn-stopping` reconciliation steer. Removed all TODO reading, counting, and state mutation.
- Replaced the `6/10` + `8/12` thresholds, `progressMinChars`, `installProgressPolicy`, `reconcileOnTurnStop`, and `exemptTools` options with the single `reminderAfterCalls` option (`8` by default, `0` disables reminders).
- Counted calls are now **completed top-level** calls observed at `tools/post-execute`, independent of success or another policy's denial. Reasoning-only messages, tool results, and plugin-authored messages no longer reset the interval.
- Split the implementation into a pure `src/policy.ts` (silence state, message predicate, reminder composition, prompt text) and a thin `src/index.ts` adapter that registers exactly `session/event` and `tools/post-execute`.
- Added `test/runtime.test.mjs`, a fake-`ctx` harness that exercises the built plugin: threshold reminder, reset semantics, nested-call exclusion, parallel single-notice behavior under out-of-order settling, success/failure/denial-independent counting, `0`-disables behavior, turn disposal, post-execute composition, and the absence of any guard or extra listener.
- Updated the runtime documentation for v0.3: `README.md`, `docs/DESIGN.md`, `docs/HOW-IT-WORKS.md`, `docs/VERIFICATION.md`, `docs/PRACTICES.md`, and `docs/SOURCES.md`.

## 0.2.1

- Documentation-focused update; runtime behavior is unchanged from 0.2.0.
- Added `docs/CODEX-PRACTICES.md`, a source-backed deep dive into Codex commentary vs final-answer semantics, preambles, liveness cadence, plan maintenance, structured questions, async user messaging, compaction/resume behavior, reasoning summaries, and transport fidelity.
- Added an explicit “adopt / adapt / do not copy blindly” mapping from current Codex practices to DSH.
- Expanded Codex source provenance to include the current `models-manager/models.json` instruction templates and current interaction-tool/protocol sources, rather than relying mostly on the older GPT-5.1 prompt.
- Documented two important sharp edges from current Codex issues: fixed commentary cadence can conflict with user preferences, and downstream transports can lose commentary/final phase fidelity.
- Corrected three documented claims against an installed harness tree and added `docs/HOW-IT-WORKS.md`: patch-row `config` replacement still re-fills omitted options from hard-coded defaults (and a partial override can fail a cross-field check), `eventAt()`/`snapshotEvents()`/`ownEvents()` are deprecated by policy rather than removed or type-marked, and `docs/DESIGN.md` no longer implies the two lanes' counters are fully independent. `docs/SOURCES.md` section G records the re-check.

## 0.2.0 — 2026-09-16

- Added independent **communication freshness** tracking from visible `assistant/message` text.
- Added soft/hard progress thresholds (`8/12` by default).
- Added `progressMinChars` anti-empty-status fallback heuristic.
- Added optional persistent system-prompt policy for high-information mid-turn progress narration.
- Combined TODO and communication obligations when both become stale.
- Kept `todo_write` as an always-reachable repair tool and kept PTC outer `run_code` exempt while nested native calls count.
- Expanded source/provenance documentation into `docs/SOURCES.md` with official, community, and external-comparison sections.
- Added `docs/DESIGN.md` and `docs/VERIFICATION.md`.
- Preserved the one-shot `agent/turn-stopping` TODO reconciliation guard from 0.1.0.

## 0.1.0

- Initial TODO freshness soft reminder / hard tool guard.
- One-shot turn-stop TODO reconciliation.
