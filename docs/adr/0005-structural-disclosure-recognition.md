# Recognize an explicit disclosure structure before resetting reminders

Status: accepted (2026-09-26). The user confirmed shared understanding and explicitly invoked the implementation phase; the runtime recognizer and model-facing policy now implement this decision.

The supplied session export contains model-authored visible messages such as "Now the replay check in `choose_nested`:" that satisfied the previous reset predicate while providing no finding or investigation basis. The confirmed design direction is to replace the any-visible-text reset rule with an explicit model-authored disclosure structure checked deterministically, rather than adding a model call to judge prose.

## Confirmed decisions

- Disclosure covers recent concrete work and its result or remaining uncertainty, the next intended action, and the intended approach. Findings, changes to a settled plan or constraint, and specific uncertainties remain useful content, but they are not separate required categories. A successful result or a new conclusion is not required: describe what was investigated, the current result, and how the next step will narrow uncertainty.
- Announcing the next action alone, acknowledging the user, or generically saying that investigation continues is insufficient under the model-facing disclosure contract.
- Runtime recognition checks the agreed structure. It does not verify the truth, novelty, relevance, or usefulness of the contents; text can satisfy a structure while still being uninformative.
- The disclosure is readable visible model text with an explicit disclosure heading and three content fields: recent work, next intended action, and intended approach. The agreed illustration is:

  ```text
  披露：
  已做：对照了序列化与回放记录，尚未定位差异来源。
  将做：确认奖励索引映射是否一致。
  做法：逐项比较原始奖励索引与回放选择索引。
  ```

- The recent-work field states what was done and the result or remaining uncertainty. The next-action field states the immediate target. The approach field states intended external operations or verification, without requesting private chain-of-thought. This four-line shape replaces the earlier finding/change/unresolved plus next-action shape.
- No opening disclosure is required. A model that chooses to send a structured opening disclosure may truthfully state that execution has not started, then describe the next action and approach; a complete structure qualifies for reset.
- A blocker may be expressed through waiting and a conditional follow-up: recent work states the attempted action and blocker, the next-action field names the dependency being awaited, and the approach field explains what can happen after it is available. The model need not invent executable work to fill a field, and recognition does not force continuation.
- Unstructured text does not reset accounting, even when a human would find it useful. This deliberately accepts an occasional unnecessary reminder rather than adding a heuristic prose-quality judgment.
- Repeating a complete structured disclosure resets accounting, including when its content is unchanged. Do not add deduplication or a novelty test; the user explicitly selected reset over the proposed deduplication rule.
- Support corresponding Chinese and English label sets with unrestricted prose language, using one label set consistently within a disclosure: `披露 / 已做 / 将做 / 做法` or `Disclosure / Done / Next / Approach`.
- Incomplete structure does not reset accounting and does not trigger an additional immediate correction. Explain the required structure through the next normally due reminder within the existing cadence and budget.
- Recognize a disclosure only when the entire visible text directly uses the agreed four-line structure, allowing surrounding whitespace, with all three content fields present and non-empty. Fenced or indented code blocks, blockquotes, and examples embedded in other prose do not qualify. The same assistant message may also contain tool calls. The fenced illustration in this document demonstrates the format; an actual model disclosure must be direct visible text without a fence.
- Preserve the cadence: one reminder per eight completed top-level tool calls, with at most three delivered reminders per disclosure interval by default. A recognized structured disclosure resets the call count, reminder budget, and activity projection together; ordinary visible text resets none of these. Existing configuration and turn-local lifecycle remain in force.
- Reminder wording must describe the absence of a recognized structured disclosure, not assert the absence of all visible model text. "Silence interval" retains its literal meaning; "disclosure interval" names the interval for the proposed accounting.
- Disclosure remains model-authored and best-effort. The existing no-guard, no-tool-denial, separate-task-accounting boundaries remain in force.

## Responsibility boundary

The standing policy and normal soft reminder explain the expression contract and ask the model for useful, factual content. Content examples for investigation, an opening disclosure, or a blocker clarify that obligation; they do not introduce separate runtime classifiers or require every example to be copied into the system prompt. The runtime observes model provenance, direct visible text, and the agreed complete structure. It does not review what was done, whether the next action is sensible, whether the approach is adequate, or whether any field is informative.

The intended improvement is that an ordinary action announcement cannot automatically reset reminder accounting. A complete structure containing vague, repeated, or false text still can; the chosen design does not solve semantic disclosure quality. This limitation is part of the deterministic-recognition choice, not a hidden guarantee that more detailed prompting will eliminate empty prose.

The exported state helpers retain their historical `SilenceState`, `createSilence()`, and `resetSilence()` names for compatibility with existing public policy callers. Their accounting now belongs to a disclosure interval; the names do not imply that ordinary visible speech resets the interval.

## Relationship to earlier decisions

This decision supersedes the any-visible-text reset clauses in [ADR-0003](0003-model-authored-disclosure.md) and [ADR-0004](0004-bounded-repeat-reminders.md). Their historical implementation used silence intervals; the new reminder accounting belongs to a disclosure interval.

## Design checkpoint

The design frontier is empty and the user confirmed shared understanding. The design workflow is complete; implementation was authorized through a separate explicit invocation of the `implement` skill.
