# Verification record

Artifact build date: 2026-09-16. Package version: **0.3.0**.

## Checks run in the generation environment

The generation environment installed the full devDependency graph (TypeScript 6.0.3 plus the DSH
`0.1.5-rc.2` type packages) and ran:

```bash
npm install --no-audit --no-fund --cache ./.npm-cache   # local cache: the default npm cache is outside the sandbox
npm run typecheck                                       # tsc -p tsconfig.json --noEmit, clean
npm run build                                           # tsc -p tsconfig.json -> lib/
npm test                                                # 24 tests, 24 pass, 0 fail
node --check lib/index.js
node --check lib/policy.js
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"
```

The suite is split deliberately:

- `test/policy.test.mjs` (14 tests) exercises `lib/policy.js` only. That module imports nothing from the
  host, so the state machine, the message predicate, the reminder composition, and the prompt/reminder
  text are verifiable without the DSH dependency graph.
- `test/runtime.test.mjs` (10 tests) imports the built `lib/index.js` and drives `apply()` with a fake
  `ctx`: it asserts the registration surface (`session/event` + `tools/post-execute`, zero guards, one
  prompt section, one fiber-owned disposer), the threshold reminder, reset semantics, nested-call
  exclusion, single-notice parallel behavior under out-of-order settling, success/failure/denial
  independence, `reminderAfterCalls: 0`, `turn/end` disposal, and post-execute composition over `accept`,
  value-replacing `accept`, and `block` downstream decisions.
  If the host dependency graph is absent, this file skips itself with an explicit reason instead of
  failing the suite. That path was checked by copying `lib/` and `test/` into a directory outside the
  repository: `14 pass, 10 skipped, 0 fail`.

### Sandbox note

The generation sandbox blocks the named pipe that Node's test runner uses to spawn each test file, so a
plain `npm test` fails there with `spawn EPERM` before any test runs. The suite was run through the
runner as `npm test` with the sandbox restriction lifted, and independently as:

```bash
node --test --test-isolation=none test/policy.test.mjs test/runtime.test.mjs   # 24 pass
```

Neither result depends on the isolation mode.

## Not verified here

No live DSH profile was booted. The plugin was checked at contract level (type declarations plus
implementation source in the installed tree) and against a fake `ctx`, not against a running Web or
headless profile. Run this locally before treating the release as production-ready:

```bash
dsh plugin --profile web add ./dsh-disclosure-policy-0.3.0
dsh --profile web --dump-config
dsh --profile web
```

The first real boot should verify:

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
