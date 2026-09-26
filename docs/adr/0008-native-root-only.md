# Limit disclosure to native top-level Agents

Status: accepted (2026-09-26)

ADR-0007 established `disclose_progress({ done, next, approach })` as the non-terminal progress primitive and initially made it available in both Native and PTC presentation. That protocol choice remains useful, but the deployment scope is narrower than the original ADR assumed.

PTC already collapses model-visible execution behind `run_code`, and one outer program can contain many nested native operations. Mapping those internal dispatches back onto a human-progress cadence creates an accounting policy that is both noisy and ambiguous. Runtime child Agents have a different supervision relationship as well: their parent owns the delegation lifecycle and receives their result/report. Giving every child another progress primitive and reminder cadence duplicates context and narration inside delegated work.

## Decision

The host policy is **exact-native-root-only**.

An Agent receives this plugin's disclosure surface only when both are true at installation time:

1. it is a live runtime root according to `ctx.agents.roots()`;
2. its effective ToolRuntime view is exact `native`, detected by the absence of reserved `run_code` from `agent.ctx.tools.get(RUN_CODE_NAME, agent)`.

Consequently:

- `ptc` Agents receive no `disclose_progress` tool, SDK binding, counters, or reminder listener;
- `both` Agents are also excluded because their effective view contains `run_code`;
- runtime-owned child/subagent Agents are excluded even when they present tools natively;
- eligible roots receive the tool, `session/event` listener, and `tools/post-execute` listener through `agent.ctx`, not through the host-global tool/listener layer.

The plugin listens globally only for `agent/created` so it can discover future eligible roots. It also scans existing roots when mounted so hot reload can install onto an already-live eligible Agent.

## Why runtime ownership, not session lineage

DSH deliberately separates live Agent ownership from durable Session lineage. A resumed fork can be a runtime root, while a continuable child is explicitly owned by its live parent. The authoritative runtime relation is therefore `AgentRegistry.roots()` / `isOwnedBy()`, not `SessionHeader.origin`, `parentSession`, fork metadata, or a Context ancestry heuristic.

This keeps "subagent" aligned with the thing this policy actually cares about: whether another live Agent owns this Agent's execution lifecycle.

## Why inspect the effective tool view

The process-wide tools config is insufficient because Agent presets can call `tools.presentAs()` and select presentation per scope. ToolRuntime's public scoped `get()` resolves that effective view, and its reserved `run_code` transport is inserted for non-native presentation. Testing for that transport therefore follows the same scoped composition the model will actually see.

`agent/created` is emitted after Agent setup and before queued input is released, so preset-owned tool presentation is already composed before eligibility is sampled.

## Lifecycle boundary

Eligibility is sampled on Agent creation and when the plugin mounts over existing roots. The plugin does not support a live Agent changing between Native and PTC/both presentation after creation; reload or recreate the Agent after changing presentation.

This avoids adding a second dynamic registration state machine whose own `tools/change` events could recursively react to disclosure-tool registration.

## Consequences

- The former PTC cadence mismatch is removed from policy scope instead of approximated with virtual nested-work units.
- PTC/both requests pay no disclosure-tool schema or generated-SDK cost.
- Runtime children pay no disclosure schema cost and receive no duplicate reminders.
- The host now depends on `@deepseek-ai/dsh-agent` for explicit runtime root identity.
- The native-root cadence, checkpoint-step sibling accounting, reminder budget, activity hint, and structured fields remain unchanged.
- The pure policy helper still supports a `nested` counting option for compatibility, but the current host adapter does not install itself into PTC/both Agent scopes.

ADR-0008 supersedes ADR-0007 only for deployment scope and PTC behavior. ADR-0007's structured progress action, compact schema, no-prose-recognition rule, and no-stop-steering decision remain in force.
