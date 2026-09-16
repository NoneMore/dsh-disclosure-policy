# AGENTS.md

This repository is a small DeepSeek Harness policy plugin. Keep runtime behavior auditable and avoid relying on private chain-of-thought.

When changing policy:

- keep native task accounting separate from model-authored disclosure; this plugin does not monitor or enforce `todo_write` freshness;
- treat the caller-supplied execution brief as an input, not something the plugin discovers or validates;
- do not automatically infer semantic completion from tool traffic;
- prefer first-party durable `session/event` facts plus live plugin projections over deprecated synchronous Session scans;
- do not register `ctx.tools.guard()`; deliver the single soft reminder through `tools/post-execute.additionalContexts`;
- do not synchronously `agent.steer()` from a `session/event` callback; the Session append path is non-reentrant;
- avoid new custom durable event types until the out-of-tree persistence compatibility contract is intentionally handled;
- keep source provenance current in `docs/SOURCES.md` whenever behavior relies on a DSH contract or community workaround.

Run `npm test` and Node syntax checks before packaging. If full DSH dependencies are installed, also run `npm run typecheck` and boot a real profile.

## Research docs

When changing disclosure behavior, read `docs/SOURCES.md` first and then `docs/CODEX-PRACTICES.md`. The Codex note distinguishes current official public-source behavior from issue evidence and explicitly calls out practices that should not be copied blindly into DSH.

## Agent skills

### Issue tracker

Issues and specs live as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
