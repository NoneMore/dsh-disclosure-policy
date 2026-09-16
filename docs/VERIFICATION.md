# Verification record

Artifact build date: 2026-09-16.

Version 0.2.1 is documentation-only relative to 0.2.0; runtime source and prebuilt `lib/` are unchanged.

## Checks run in the generation environment

The package was checked with:

```bash
node --test test/*.test.mjs
node --check lib/index.js
node --check lib/policy.js
tsc --noEmit --strict --target ES2023 --module NodeNext --moduleResolution NodeNext src/policy.ts
python -m json.tool package.json
python -c 'import yaml, pathlib; yaml.safe_load(pathlib.Path("cordis.patch.yml").read_text())'
unzip -t ../dsh-todo-checkpoint-guard-0.2.1.zip
```

The pure policy module can also be strict-typechecked independently when TypeScript is available without resolving the full DSH host imports.

## Not verified here

This generation environment does not contain a complete install of the DSH 0.1.5-rc.2 npm dependency graph, so it did **not** run:

```bash
npm install
npm run typecheck
dsh plugin --profile web add ./dsh-todo-checkpoint-guard-0.2.1
dsh --profile web
```

Run those locally before treating the plugin as production-ready. In particular, the first real boot should verify:

1. optional `ctx.get('systemPrompt')` registration on your selected bundle;
2. `assistant/message` reset behavior when a response contains both visible text and tool calls;
3. PTC nested dispatch behavior under your code-mode configuration;
4. one-shot `agent/turn-stopping` continuation without a stop loop;
5. interaction with other tool-policy/permission plugins in your profile.
