# Verification record

## Native main-agent scope: current checkout (2026-09-26)

Verified PR #5 / `fix/native-root-only-disclosure`, with package version still `0.4.1` (unreleased changes).

- GitHub Actions CI run **#71** passed on Node **22.19.0** and **24**.
- On both jobs: `npm run typecheck`, `npm run build`, `npm test`, committed-`lib/` verification, and package-content verification passed.
- Final test result for the scoped implementation: **33 passed, 0 failed, 0 skipped**.
- Runtime coverage verifies that exact-native main roots receive `disclose_progress` plus scoped listeners, while `ptc`, `both`, live runtime children, and cold-resumed subagent lineage receive only the host-global `agent/created` discovery listener and no disclosure tool/accounting surface.
- A separate regression keeps an ordinary top-level fork eligible when it has `parentSession`/seed lineage but no subagent `origin` and zero delegation depth.
- The eligibility contracts were re-checked against DSH public source: `AgentRegistry.roots()` represents current live ownership, `SessionHeader.origin` / `delegationDepth` preserve subagent lineage across resume, scoped ToolRuntime `get('run_code', agent)` distinguishes exact native from `ptc`/`both`, and `agent/created` is awaited after setup before queued input runs.
- No real routed-model/profile run was added for this scope change; CI validates the adapter, type contracts, committed build output, and package shape.

## Checkpoint-step accounting: current checkout (2026-09-26)

Verified PR #4 / `fix/count-checkpoint-step-work`, with package version still `0.4.1` (unreleased changes).

- GitHub Actions CI run **#68** passed on Node **22.19.0** and **24**.
- On both jobs: `npm run typecheck`, `npm run build`, `npm test`, committed-`lib/` verification, and package-content verification passed.
- Final test result: **34 passed, 0 failed, 0 skipped**.
- The new regression covers top-level siblings settling both before and after a successful checkpoint in one Assistant step; all are carried into the fresh interval while reminder delivery remains fenced to a later model step.
- The nested/PTC regression verifies that the enclosing `run_code` now advances the fresh interval when it settles after a nested checkpoint.
- Existing coverage still includes failed and whitespace-only checkpoints, one-reminder-per-model-step fencing, activity preservation, downstream failure/block composition, turn lifecycle, and absence of guards / turn-stop steering.
- This CI validates host/runtime behavior, committed build output, and package shape; it does **not** add real routed-model evidence.

## Structured progress tool: prior checkpoint (2026-09-26)

Verified the ADR-0007 refactor on PR #3 / `fix/continue-after-disclosure`, with package version still `0.4.1` (unreleased changes).

- GitHub Actions CI run **#64** passed on Node **22.19.0** and **24**.
- On both jobs: `npm run typecheck`, `npm run build`, `npm test`, committed-`lib/` verification, and package-content verification passed.
- Final test result: **33 passed, 0 failed, 0 skipped**.
- Runtime coverage includes native and nested/PTC `disclose_progress`, failed and whitespace-only checkpoints, same-step parallel settlement ordering, one-reminder-per-model-step fencing, activity preservation, downstream failure/block composition, turn lifecycle, and absence of guards / turn-stop steering.
- The model-facing tool declaration is regression-bounded to less than **360 JSON bytes** in the fake-host projection. The tool description and base reminder are each **118 characters**. Parameter descriptions are omitted.
- Successful checkpoint output is canonical `null` and renders **zero model-facing result blocks**. The tool explicitly opts into parallel scheduling so it does not fall into DSH's fail-closed exclusive default.
- No standing disclosure system-prompt section is mounted. The now-unused direct `dsh-agent` and `dsh-system-prompt` peer/dev dependencies were removed.
- The current CI verifies packaging and static/runtime contracts but does **not** drive a real routed model through a checkpoint in a Web profile. Earlier profile boots below predate ADR-0007 and must not be treated as live evidence for the new tool protocol.

## Recent activity window: prior checkpoint (2026-09-26)

Verified ADR-0006 on the current branch with package version still `0.4.1` (unreleased changes). Review fixed point: `adae5e6d80e9eb05db97d5515a5531ba5a89f54a`.

- TDD began with a failing public policy regression for an old edit/test leaving the window, followed by configuration and plugin-boundary cycles. Individual test files and typechecking ran throughout development.
- `npm run build`, `npm run typecheck`, and final `npm test`: **48 passed, 0 failed, 0 skipped** (27 policy, 21 runtime).
- Node syntax checks on both built JavaScript files and both test files, plus `git diff --check`: passed.
- The default edit followed by 30 reads/searches regression delivers ordinary reminders at top-level calls 8/16 and an activity hint at call 24, then sends no extra notices after budget exhaustion.
- Public tests cover partial windows, `other` eviction, configuration validation and hint-only disabling, preservation across disclosure (including failed nested verification), nested/composite observations, parallel observation order, and empty state on a new turn or hot reload.
- Review against the recorded fixed point: Standards found no violations; Spec found an explicit `null` defaulting past activity validation. That finding was fixed with defaults applying only to omitted/`undefined` values and regressions at both agreed public boundaries; the Spec reviewer confirmed resolution.
- `npm pack` and isolated real Web-profile installation/boot under DSH **0.1.7-rc.2**: passed. The composed row contains `reminderAfterCalls: 8`, `maxReminders: 3`, `activityWindowSize: 16`, and `inspectionHintMinInspections: 8`.

The profile was `activity-review` under an isolated temporary `DSH_HOME`, with package cache and pnpm store in the same allowed temporary root. Commands matched the profile workflow below, using the new profile name. A hidden Node helper launched the CLI with telemetry disabled, `--no-open --port 0`, observed the loopback listen URL, confirmed an HTTP response (401 for an unauthenticated request), and terminated its child process. Boot validates mounting and defaults; no controlled live model turn or real-use tuning period was performed.

## Structured disclosure: prior checkpoint (2026-09-26)

Verified the ADR-0005 implementation on the current branch, with package version still `0.4.1` (unreleased changes):

- `npm run build` and `npm run typecheck`: passed.
- Individual policy/runtime file runs throughout TDD, then `npm test`: **39 passed, 0 failed, 0 skipped** (24 policy, 15 runtime).
- `node --check` on both built JavaScript files and both test files: passed.
- `git diff --check`: passed.
- `npm pack --pack-destination <temp> --json`: passed; the packed artifact was installed into an isolated profile, whose composed row contained `disclosure-policy`, `reminderAfterCalls: 8`, and `maxReminders: 3`.
- Real Web profile boot with globally installed DSH **0.1.7-rc.2**: loaded the packed plugin and listened at a loopback address. Telemetry was disabled and the browser was not opened. The created process tree was terminated after verification; termination required escalation because the Windows sandbox denied it.

The isolated environment used a fresh directory under the allowed Windows temporary root for `DSH_HOME`, npm cache, pnpm store, package, and logs. Profile commands were:

```powershell
dsh --profile structured-review --from-default-profile web --dump-config
dsh plugin --profile structured-review add <temp>/dsh-disclosure-policy-0.4.1.tgz --store-dir <temp>/pnpm-store
dsh --profile structured-review --dump-config
dsh --profile structured-review --no-open --port 0
```

The boot was launched as a hidden background Node process with output redirected to files. It validates packaging, mount, schema, and service startup. It does **not** establish that a real model will follow the format, provide useful contents, or reset at the right moment in a controlled live turn. Those structural/reset claims are covered by the public policy tests and the fake-host `apply()` harness, which also verifies that ordinary/malformed text preserves cadence, budget, and activity, while complete repeated disclosure resets all three.

## Historical release checks

Artifact build date: 2026-09-17. Package version: **0.4.0**.

Re-verified for 0.4.0 (bounded repeat reminders; see `docs/adr/0004-bounded-repeat-reminders.md`):
`npm run build` clean, `npm run typecheck` clean, `npm test` 28 tests / 28 pass / 0 fail, and the
direct per-file and `--test-isolation=none` runs below. The 0.3.0 boot and version-inspection evidence
still applies to the mount path, which 0.4.0 did not change; the packaged filename and the config row
now also carry `maxReminders`.

## Checks run in the release-review environment

The release-review environment installed the full devDependency graph (TypeScript 6.0.3 plus the DSH
`0.1.5-rc.2` type packages) and ran:

```bash
npm install --no-audit --no-fund --cache ./.npm-cache   # local cache: the default npm cache is outside the sandbox
npm run typecheck                                       # tsc -p tsconfig.json --noEmit, clean
npm run build                                           # tsc -p tsconfig.json -> lib/
npm test                                                # 28 tests, 28 pass, 0 fail
node --check lib/index.js
node --check lib/policy.js
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"
```

The suite is split deliberately:

- `test/policy.test.mjs` (17 tests) exercises `lib/policy.js` only. That module imports nothing from the
  host, so the state machine, the message predicate, the reminder composition, the cadence/budget
  arithmetic, the repeat text, and the prompt/reminder text are verifiable without the DSH dependency
  graph.
- `test/runtime.test.mjs` (11 tests) imports the built `lib/index.js` and drives `apply()` with a fake
  `ctx`: it asserts the registration surface (`session/event` + `tools/post-execute`, zero guards, one
  prompt section, one fiber-owned disposer), the delivered cadence and its budget, reset semantics,
  nested-call exclusion, single-notice parallel behavior under out-of-order settling,
  success/failure/denial independence, downstream-policy exception accounting with deferred delivery
  that spends no budget slot, disabling via either option, `turn/end` disposal, and post-execute
  composition over `accept`, value-replacing `accept`, and `block` downstream decisions.
  If the host dependency graph is absent, this file skips itself with an explicit reason instead of
  failing the suite. That path was checked by copying `lib/` and `test/` into a directory outside the
  repository: `17 pass, 11 skipped, 0 fail`.

### Runner note

An earlier generation sandbox blocked the named pipe that Node's test runner uses to spawn each test
file, which makes plain `npm test` fail with `spawn EPERM`. The release-review environment ran the
normal isolated command successfully, and where that sandbox applies the suite also supports:

```bash
node test/policy.test.mjs          # in-process, no per-file spawn
node test/runtime.test.mjs
node --test --test-isolation=none test/policy.test.mjs test/runtime.test.mjs   # 28 pass
```

The behavior does not depend on the isolation mode. The 0.4.0 verification used all three forms.

## Real profile boot

Release review packed the artifact, created an isolated Web profile under a temporary `DSH_HOME`,
installed the tarball, inspected the composed patch row, and booted the profile with telemetry disabled:

```bash
npm pack --pack-destination <temp>/package
DSH_HOME=<temp>/dsh-home dsh --profile release-review --from-default-profile web --dump-config
DSH_HOME=<temp>/dsh-home dsh plugin --profile release-review add <temp>/package/dsh-disclosure-policy-0.3.0.tgz
DSH_HOME=<temp>/dsh-home dsh --profile release-review --dump-config
DSH_HOME=<temp>/dsh-home DSH_TELEMETRY_MODE=DISABLED dsh --profile release-review --no-open --port 0
```

The composed tree contained `id: disclosure-policy`, `name: dsh-disclosure-policy`, and
`reminderAfterCalls: 8`. The Web profile loaded successfully and listened on an OS-assigned loopback
port before being shut down. (0.4.0 re-runs this with the tarball
`dsh-disclosure-policy-0.4.0.tgz` and additionally expects `maxReminders: 3` in the composed row.)

## Live session observation (2026-09-17)

While the 0.4.0 change was being implemented, the plugin was mounted in the running Web session used
for that work, and its reminders appeared in the transcript repeatedly during one long chain of tool
calls. This confirms in a live turn what the suite only asserts against a fake `ctx`:

- the reminder is delivered as a plugin-sourced `notice` row and reaches the model's next step;
- delivery never denied, blocked, or altered a tool call.

It is **not** evidence about the cadence or the budget. The session observed the notices, not which
budget index each one carried and not which turn each one belonged to, so repeated notices across the
session are consistent with both the new cadence and the old one-shot latch repeating once per turn.
The cadence and budget claims rest on the unit and runtime tests.

## Not exercised end to end for the current refactor

The CI proves the host adapter, accounting state machine, tool schema, build output, and package shape. The following still need real-profile / real-model evidence before they should be stated as observed behavior:

1. a routed model actually chooses `disclose_progress` at the semantic moments in its compact description and after a reminder;
2. when executable work remains, the model commonly batches the checkpoint with sibling work calls rather than spending a dedicated model round-trip;
3. native and PTC/nested tool rows expose the checkpoint arguments clearly enough for supervision in the target client surface;
4. deployment-specific pre/post tool policies (including approval or blocking policy) compose with the checkpoint without unexpected interaction friction;
5. a nested PTC checkpoint resets the interval in the real profile exactly as the fake-host regression asserts;
6. the compact reminder reaches the next model step under the target provider route and the one-reminder-per-step fence behaves as expected under real parallel fan-out.

No current claim depends on Assistant prose resetting disclosure state, a standing prompt section, or `agent/turn-stopping` steering; ADR-0007 removed those mechanisms.

## Previous releases

Version 0.3.0 (2026-09-16) is the release this document originally recorded: 25 tests, one-shot
reminder, boot verified. Version 0.2.1 was documentation-only relative to 0.2.0 and was verified
without an installed dependency graph. Their checks and outstanding boot tests are preserved in the
repository history.
