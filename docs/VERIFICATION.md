# Verification record

## Structured disclosure: current checkout (2026-09-26)

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

## Not exercised end to end

The boot proves that the packed plugin resolves, validates, and mounts in a real profile. It did not
drive a controlled live model turn through a complete budget, so the following still have no
end-to-end evidence:

1. the prompt section lands at order `10150` and is not suppressed by a deployment `complete: true` prompt;
2. a real `assistant/message` carrying both visible text and tool calls resets the interval before the
   tool results settle;
3. nested dispatches under the profile's tool mode carry `exec.parent` and therefore do not count;
4. a reminder appears as one plugin-sourced `notice` row and reaches the next model step;
5. composition with other tool-policy plugins in the profile (result transformers, spill policy, approval
   gates) leaves their decisions intact;
6. no guard is registered and no tool call is ever denied by this plugin;
7. the interval stays silent after `maxReminders` notices until visible model text opens a new one.

## Previous releases

Version 0.3.0 (2026-09-16) is the release this document originally recorded: 25 tests, one-shot
reminder, boot verified. Version 0.2.1 was documentation-only relative to 0.2.0 and was verified
without an installed dependency graph. Their checks and outstanding boot tests are preserved in the
repository history.
