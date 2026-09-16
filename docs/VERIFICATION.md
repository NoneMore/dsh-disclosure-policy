# Verification record

Artifact build date: 2026-09-16. Package version: **0.3.0**.

## Checks run in the release-review environment

The release-review environment installed the full devDependency graph (TypeScript 6.0.3 plus the DSH
`0.1.5-rc.2` type packages) and ran:

```bash
npm install --no-audit --no-fund --cache ./.npm-cache   # local cache: the default npm cache is outside the sandbox
npm run typecheck                                       # tsc -p tsconfig.json --noEmit, clean
npm run build                                           # tsc -p tsconfig.json -> lib/
npm test                                                # 25 tests, 25 pass, 0 fail
node --check lib/index.js
node --check lib/policy.js
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"
```

The suite is split deliberately:

- `test/policy.test.mjs` (14 tests) exercises `lib/policy.js` only. That module imports nothing from the
  host, so the state machine, the message predicate, the reminder composition, and the prompt/reminder
  text are verifiable without the DSH dependency graph.
- `test/runtime.test.mjs` (11 tests) imports the built `lib/index.js` and drives `apply()` with a fake
  `ctx`: it asserts the registration surface (`session/event` + `tools/post-execute`, zero guards, one
  prompt section, one fiber-owned disposer), the threshold reminder, reset semantics, nested-call
  exclusion, single-notice parallel behavior under out-of-order settling, success/failure/denial
  independence, downstream-policy exception accounting with deferred delivery, `reminderAfterCalls: 0`,
  `turn/end` disposal, and post-execute composition over `accept`, value-replacing `accept`, and `block`
  downstream decisions.
  If the host dependency graph is absent, this file skips itself with an explicit reason instead of
  failing the suite. That path was checked by copying `lib/` and `test/` into a directory outside the
  repository: `14 pass, 11 skipped, 0 fail`.

### Runner note

An earlier generation sandbox blocked the named pipe that Node's test runner uses to spawn each test
file. The release-review environment ran the normal isolated command successfully and also supports:

```bash
node --test --test-isolation=none test/policy.test.mjs test/runtime.test.mjs   # 25 pass
```

The behavior does not depend on the isolation mode.

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
port before being shut down.

## Not exercised end to end

The boot proves that the packed plugin resolves, validates, and mounts in a real profile. It did not
drive a live model turn through the reminder threshold. A manual or automated host-level scenario can
still verify:

1. the prompt section lands at order `10150` and is not suppressed by a deployment `complete: true` prompt;
2. a real `assistant/message` carrying both visible text and tool calls resets the interval before the
   tool results settle;
3. nested dispatches under the profile's tool mode carry `exec.parent` and therefore do not count;
4. a reminder appears as one plugin-sourced `notice` row and reaches the next model step;
5. composition with other tool-policy plugins in the profile (result transformers, spill policy, approval
   gates) leaves their decisions intact;
6. no guard is registered and no tool call is ever denied by this plugin.

## Previous release

Version 0.2.1 was documentation-only relative to 0.2.0 and was verified without an installed dependency
graph. Its checks and its outstanding boot test are preserved in the repository history.
