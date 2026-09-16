# Codex interaction mechanics: progress commentary, plan state, and mid-turn questions

Fact-finding report on how the public `openai/codex` source makes the model communicate
progress and interact with the user during long work.

## Provenance and retrieval method

| Item | Value |
| --- | --- |
| Repository | `https://github.com/openai/codex` |
| Retrieval method | `git clone --depth 1 https://github.com/openai/codex .scratch/research/codex-src` (pwsh), **succeeded** |
| Retrieved on | 2026-09-16 (local `+08:00`) |
| Cloned HEAD | `8f38d5a877da8c5c2c0b5158e72bb5f2290a3157` |
| HEAD commit date | `2026-09-16T10:11:26Z` |
| HEAD subject | `Make Code Mode wrappers transparent to Guardian model policies (#45915)` |

All paths named in the request exist at this commit. **No `web_fetch` fallback and no
`web_search` path-discovery were needed for any source file** — every `.rs`, `.md`, and
`.json` path resolved inside the local clone. `web_fetch`/`web_search` were used only for
the GitHub issue evidence in Q8.

Everything below labeled **[source]** is quoted or transcribed from that clone.
Everything labeled **[fetch]** comes from a network fetch of `api.github.com`.
Everything labeled **[inference]** is my own reasoning, not source text.

The nine requested paths, all present:

```
codex-rs/models-manager/models.json                       OK
codex-rs/models-manager/prompt.md                         OK
codex-rs/core/gpt_5_1_prompt.md                           OK
codex-rs/protocol/src/prompts/base_instructions/default.md OK
codex-rs/protocol/src/models.rs                           OK
codex-rs/protocol/src/items.rs                            OK
codex-rs/core/src/tools/handlers/plan_spec.rs             OK
codex-rs/core/src/tools/handlers/request_user_input_spec.rs OK
codex-rs/protocol/src/openai_models.rs                    OK
codex-rs/collaboration-mode-templates/templates/*.md      default.md, plan.md
```

---

## Q1. What the model instruction templates say about mid-turn commentary

### The numeric cadence lives in `models.json`, not in the checked-in `.md` prompts

`codex-rs/models-manager/models.json` is the model catalog (`{"models": [...]}`, 9 entries,
1130 lines). Each entry has a `model_messages.instructions_template` string. **Each template
is one very long JSON line**, so line numbers below are the line of that model's
`"instructions_template"` key.

**[source]** The current-generation templates — `gpt-6-astra` (line 75), `gpt-5.6-sol`
(242), `gpt-5.6-terra` (372), `gpt-5.6-luna` (493), `gpt-daybreak-blue-latest` (622),
`gpt-daybreak-red-latest` (739), `codex-auto-review` (1069) — all contain this section,
verbatim (reproduced from `gpt-5.6-sol`, line 242; `\n` unescaped for readability):

> ## Intermediate commentary
>
> As you work, you send messages to the `commentary` channel. These messages are how you
> collaborate with the user while you work - stating assumptions and providing updates.
> These messages should be concise and quickly scannable. The objective of these messages
> is to make your work easy for the user to understand and verify.
>
> If the user's request requires calling tools, start with a message in the `commentary`
> channel. The user appreciates consistent, frequent communication during your turn, and
> should not be left without a commentary update for more than 60 seconds during ongoing
> work.

**The exact numeric cadence is 60 seconds, and it is a ceiling on silence ("should not be
left without a commentary update for more than 60 seconds"), not a fixed interval.**

**[source]** The two legacy templates frame it as an interval rather than a ceiling —
`gpt-5.5` (line 842) and `gpt-5.4` (line 957):

> - You provide user updates frequently, every 30s.

So **"every 30s" is the older cadence; "more than 60 seconds" is the current one.** The two
coexist in the same catalog file because the catalog carries per-model templates.

**[source]** A separate, related 60-second rule appears in the same templates (7 of the 9 —
all except the `gpt-5.5`/`gpt-5.4` legacy pair), under "Rules for getting work done":

> - Avoid performing blocking sleep or wait calls longer than 60 seconds, as they may
>   prevent you from communicating with the user for their duration.

**[source]** Additional commentary rules, `gpt-6-astra` (line 75) only:

> - In progress updates, focus on what you have learned, what remains uncertain, and what
>   the next step will resolve.
>
> Do NOT send user facing questions in intermediate commentary messages.

> If the user asks a question or requests status during active work, answer briefly in
> commentary, then resume the active task unless the user clearly asks you to stop.

**[source]** All the current templates also state, in the same section:

> Do NOT put a final response (e.g. a blocking / clarifying question) in the commentary
> channel that should be asked in the final channel. Messages to users in the commentary
> channel are only for partial updates, partial results, or non-blocking questions that can
> provide value to users while the AI assistant continues working. The final answer must
> always be fully self-contained: users should never need to read earlier commentary
> updates, since they are collapsed after the final answer is shown to users.

### The checked-in markdown prompts carry the *older*, non-numeric wording

`codex-rs/models-manager/prompt.md`, `codex-rs/core/gpt_5_1_prompt.md`, and
`codex-rs/protocol/src/prompts/base_instructions/default.md` are near-identical CLI prompts
(the latter two differ only by a trailing blank line). They contain **no channel/`commentary`
vocabulary and no numeric cadence.** **[source]** `codex-rs/models-manager/prompt.md:173-179`
(identical text at `gpt_5_1_prompt.md:186-192` and `default.md:173-179`):

> ## Sharing progress updates
>
> For especially longer tasks that you work on (i.e. requiring many tool calls, or a plan
> with multiple steps), you should provide progress updates back to the user at reasonable
> intervals. These updates should be structured as a concise sentence or two (no more than
> 8-10 words long) recapping progress so far in plain language: this update demonstrates
> your understanding of what needs to be done, progress so far (i.e. files explores,
> subtasks complete), and where you're going next.

**[source]** `codex-rs/models-manager/prompt.md:31-39` (same at `default.md:31-39`,
`gpt_5_1_prompt.md`) — the preamble rules, including the only other word-count budget:

> ### Preamble messages
>
> Before making tool calls, send a brief preamble to the user explaining what you’re about
> to do. When sending preamble messages, follow these principles and examples:
>
> - **Logically group related actions**: if you’re about to run several related commands, describe them together in one preamble rather than sending a separate note for each.
> - **Keep it concise**: be no more than 1-2 sentences, focused on immediate, tangible next steps. (8–12 words for quick updates).
> ...
> - **Exception**: Avoid adding a preamble for every trivial read (e.g., `cat` a single
>   file) unless it’s part of a larger grouped action.

**Summary for Q1:** the current numeric cadence is **60 seconds** (a silence ceiling) for
`gpt-6-astra`, `gpt-5.6-{sol,terra,luna}`, `gpt-daybreak-{blue,red}-latest`, and
`codex-auto-review`; **30 seconds** ("every 30s") for `gpt-5.5` and `gpt-5.4`; and
"reasonable intervals" with no number in the three checked-in CLI prompts.

---

## Q2. Is mid-turn commentary enforced at runtime? — **No.**

There is a real pre-tool-call veto mechanism, but **nothing in it is keyed on commentary or
progress.** Below are all the enforcement mechanisms I found, and why none of them forces
the model to speak.

### (a) `PreToolUse` hooks — a genuine veto, but not a commentary gate

**[source]** `codex-rs/core/src/hook_runtime.rs:181-240`:

> /// Runs matching `PreToolUse` hooks before a tool executes.

> `PreToolUseHookResult::Blocked(format!(`
> `"Command blocked by PreToolUse hook: {reason}. Command: {command}"`

> `PreToolUseHookResult::Blocked(format!(`
> `"Tool call blocked by PreToolUse hook: {reason}. Tool: {}",`

**[source]** It is wired into every tool call at `codex-rs/core/src/tools/registry.rs:597-607`:

```rust
if let Some(pre_tool_use_payload) = tool.pre_tool_use_payload(&invocation) {
    match run_pre_tool_use_hooks(
        ...
        PreToolUseHookResult::Blocked(message) => {
```

**[source]** The complete hook event set is in `codex-rs/hooks/src/schema.rs:101-125`
(`HookEventNameWire`): `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`,
`PostCompact`, `SessionStart`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`,
`Interrupt`. **There is no commentary, progress, or message-phase event.**

**[inference]** A user-authored `PreToolUse` hook *could* in principle deny tool calls
until the model had emitted text, because hooks are arbitrary user commands that can return
`decision: block` / `permissionDecision: deny` (see
`codex-rs/hooks/src/output_parser.rs:121-175` and `schema.rs:244-278`). But no such hook
ships, no default hook exists, and no hook input carries commentary state. The veto is a
generic tool-permission mechanism, not a progress mechanism.

### (b) Every read of `MessagePhase::Commentary` in the agent loop is bookkeeping

I searched `codex-rs/core/src` for `commentary`/`Commentary` (250+ matches) and inspected
each site in the core loop. The only three that touch the running turn are:

**[source]** `codex-rs/core/src/session/turn.rs:2613-2616` — decides whether to preempt for
queued mailbox mail:

```rust
let preempt_for_mailbox_mail = match &item {
    ResponseItem::Message { role, phase, .. } => {
        role == "assistant" && matches!(phase, Some(MessagePhase::Commentary))
    }
```

**[source]** `codex-rs/core/src/stream_events_utils.rs:278-280`:

```rust
let defers_mailbox_delivery_to_next_turn =
    !matches!(agent_message.phase, Some(MessagePhase::Commentary))
        && last_agent_message.is_some();
```

**[source]** `codex-rs/core/src/stream_events_utils.rs:516-531` — the fallback path.

None of these allow, deny, delay, or retry a tool call based on whether commentary was
emitted. They control when queued user/inter-agent mail is delivered.

### (c) What *is* enforced, and how it differs

For contrast, things Codex genuinely hard-enforces at runtime:

- `update_plan` is refused in Plan mode — **[source]** `core/src/tools/handlers/plan.rs:87-91`:
  > `"update_plan is a TODO/checklist tool and is not allowed in Plan mode"`
- `request_user_input` is refused for non-root threads — **[source]**
  `core/src/tools/handlers/request_user_input.rs:69-73`:
  > `"request_user_input can only be used by the root thread"`
- `request_user_input` requires non-empty options — **[source]**
  `core/src/tools/handlers/request_user_input_spec.rs:108-114`:
  > `"request_user_input requires non-empty options for every question"`

**Conclusion for Q2:** mid-turn commentary is **purely prompt-level guidance plus protocol
phase metadata**. There is no hook, guard, watchdog, scheduler deadline, or pre-tool-call
veto anywhere in `codex-rs` that requires the model to emit progress text.

---

## Q3. The `commentary` vs `final_answer` phase distinction

### Definition

**[source]** `codex-rs/protocol/src/models.rs:937-951`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
/// Classifies an assistant message as interim commentary or final answer text.
///
/// Providers do not emit this consistently, so callers must treat `None` as
/// "phase unknown" and keep compatibility behavior for legacy models.
pub enum MessagePhase {
    /// Mid-turn assistant text (for example preamble/progress narration).
    ///
    /// Additional tool calls or assistant output may follow before turn
    /// completion.
    Commentary,
    /// The assistant's terminal answer text for the current turn.
    FinalAnswer,
}
```

### Where it is carried

**[source]** `codex-rs/protocol/src/models.rs:1020-1031` (on `ResponseItem::Message`):

```rust
    // Optional output-message phase (for example: "commentary", "final_answer").
    // Availability varies by provider/model, so downstream consumers must
    // preserve fallback behavior when this is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    phase: Option<MessagePhase>,
```

**[source]** `codex-rs/protocol/src/items.rs:145-160` (on `AgentMessageItem`):

> /// `phase` is optional because not all providers/models emit it. Consumers
> /// should use it when present, but retain legacy completion semantics when it
> /// is `None`.

> /// Optional phase metadata carried through from `ResponseItem::Message`.
> ///
> /// This is currently used by TUI rendering to distinguish mid-turn
> /// commentary from a final answer and avoid status-indicator jitter.

### Is it inferred locally or taken from provider metadata?

**Taken from provider metadata.** **[source]** `codex-rs/codex-api/src/sse/responses.rs:840-889`
is a test that feeds the literal wire payload:

```rust
"content": [{"type": "output_text", "text": "Hello"}],
"phase": "commentary"
```

and asserts it deserializes to `phase: Some(MessagePhase::Commentary)`. The enum is
`#[serde(rename_all = "snake_case")]`, so the wire values are exactly `"commentary"` and
`"final_answer"`.

**[source]** The one local, non-provider inference path I found is the realtime/voice **BEM
prefix** parser: `codex-rs/core/src/realtime_conversation/bem.rs:10-11` maps
`("analysis", "[ANALYSIS]", MessagePhase::Commentary)` and
`("commentary", "[COMMENTARY]", MessagePhase::Commentary)`, and
`codex-rs/core/src/realtime_conversation/bem_tests.rs:37-40` also maps
`"[THINKING]"`, `"[THOUGHT]"`, `"[PROGRESS]working"`, `"[UPDATE]working"` to `Commentary`.
**[inference]** This applies to the realtime conversation surface, not the ordinary
agent turn; for normal turns I found no local phase assignment.

### What happens when the provider omits it

`None` is treated as **final-answer-like** ("phase unknown" → safer legacy behavior).

**[source]** `codex-rs/core/src/stream_events_utils.rs:521-527`:

```rust
        ResponseItem::Message { role, phase, .. } => {
            if role != "assistant" || matches!(phase, Some(MessagePhase::Commentary)) {
                return false;
            }
            // Treat `None` like final-answer text so untagged providers default
            // to the safer "defer mailbox mail" behavior.
            last_assistant_message_from_item(item, plan_mode).is_some()
```

Other consumers that explicitly group `None` with non-commentary:
**[source]** `codex-rs/thread-store/src/local/thread_history.rs:517` —
`phase: Some(MessagePhase::Commentary) | None,` (both treated as "ends the turn" for summary
materialization); `codex-rs/tui/src/app/thread_title.rs:329` — ignores commentary (and `None`
is not commentary) when picking a thread title;
`codex-rs/ext/goal/src/accounting.rs:175` — `!has_text && !matches!(message.phase, Some(MessagePhase::Commentary))`.

**[source]** The TUI uses the phase to decide status-indicator behavior —
`codex-rs/tui/src/chatwidget/streaming.rs:458`: `Some(MessagePhase::Commentary) => true`.
**[source]** `codex-rs/tui/src/chatwidget.rs:25-27` explains the intent:

> //! For preamble-capable models, assistant output may include commentary before
> ... progress indicators; once commentary completes and stream queues drain, we

---

## Q4. What `update_plan` requires, and how plan state reaches the user

### The contract the model is given

**[source]** `codex-rs/core/src/tools/handlers/plan_spec.rs:42-56`:

```rust
    ToolSpec::Function(ResponsesApiTool {
        name: "update_plan".to_string(),
        description: r#"Updates the task plan.
Provide an optional explanation and a list of plan items, each with a step and status.
At most one step can be in_progress at a time.
"#
        .to_string(),
```

**[source]** Parameters, `plan_spec.rs:8-20` and `22-40`: `plan` is a required array of
objects with required `step` (string) and `status`; `explanation` is an optional string.
`status` is a string enum:

```rust
            JsonSchema::string_enum(
                vec![json!("pending"), json!("in_progress"), json!("completed")],
                Some("Step status.".to_string()),
            ),
```

### Runtime behavior — and what is *not* enforced

**[source]** `codex-rs/core/src/tools/handlers/plan.rs:87-99`:

```rust
        if turn.mode() == ModeKind::Plan {
            return Err(FunctionCallError::RespondToModel(
                "update_plan is a TODO/checklist tool and is not allowed in Plan mode".to_string(),
            ));
        }

        let args = parse_update_plan_arguments(&arguments)?;
        session
            .send_event(turn.as_ref(), EventMsg::PlanUpdate(args))
            .await;
```

**[source]** `plan.rs:108-111` — the only validation is JSON parsing:

```rust
fn parse_update_plan_arguments(arguments: &str) -> Result<UpdatePlanArgs, FunctionCallError> {
    serde_json::from_str::<UpdatePlanArgs>(arguments).map_err(|e| {
        FunctionCallError::RespondToModel(format!("failed to parse function arguments: {e}"))
    })
}
```

**[source]** `plan.rs:22` and `24-41` — the model gets a fixed, content-free acknowledgement
back: `const PLAN_UPDATED_MESSAGE: &str = "Plan updated";`

> **[inference]** The "At most one step can be in_progress at a time" invariant is stated to
> the model in the tool description and in prompts, but **is not validated in the handler.**
> A model that marks two steps `in_progress` is not corrected.

### How plan state is rendered, separately from commentary

Plan state is a **distinct UI object**, not assistant prose.

**[source]** `codex-rs/tui/src/history_cell/plans.rs:169-175`:

```rust
pub(crate) struct PlanUpdateCell {
    explanation: Option<String>,
    plan: Vec<PlanItemArg>,
}

impl HistoryCell for PlanUpdateCell {
```

**[source]** `plans.rs:203-204` renders its own header:

```rust
        let mut lines: Vec<Line<'static>> = vec![];
        lines.push(vec!["• ".dim(), "Updated Plan".bold()].into());
```

**[source]** `plans.rs:186-191` renders per-step status glyphs:

```rust
            let (box_str, step_style) = match status {
                StepStatus::Completed => ("✔ ", Style::default().crossed_out().dim()),
                StepStatus::InProgress => ("□ ", Style::default().cyan().bold()),
                StepStatus::Pending => ("□ ", Style::default().dim()),
            };
```

**[source]** It is wired in at `codex-rs/tui/src/chatwidget/turn_runtime.rs:523-536`:

```rust
    pub(super) fn on_plan_update(&mut self, update: UpdatePlanArgs) {
        self.transcript.saw_plan_update_this_turn = true;
        ...
        self.add_to_history(history_cell::new_plan_update(update));
```

**[source]** The prompts tell the model not to duplicate it — `models-manager/prompt.md:58`,
`core/gpt_5_1_prompt.md:69`, `protocol/src/prompts/base_instructions/default.md:58`:

> Do not repeat the full contents of the plan after an `update_plan` call — the harness
> already displays it. Instead, summarize the change made and highlight any important
> context or next step.

**[source]** And the "exactly one in_progress" rule is stated in prose at
`models-manager/prompt.md:273` / `default.md:273`:

> There should always be exactly one `in_progress` step until everything is done.

**[source]** Registration is config-gated: `codex-rs/core/src/config/mod.rs:1045-1046`
(`/// Whether to register the update_plan tool.` / `pub update_plan_enabled: bool`),
resolved by `resolve_update_plan_enabled` (`mod.rs:2665`) from `[tools.update_plan] enabled`,
and applied at `codex-rs/core/src/tools/spec_plan.rs:1099`.

**[source]** `update_plan` and Plan mode are explicitly separate —
`codex-rs/collaboration-mode-templates/templates/plan.md:11-15`:

> ## Plan Mode vs update_plan tool
>
> Plan Mode is a collaboration mode that can involve requesting user input and eventually
> issuing a `<proposed_plan>` block.
>
> Separately, `update_plan` is a checklist/progress/TODOs tool; it does not enter or exit
> Plan Mode. Do not confuse it with Plan mode or try to use it while in Plan mode. If you
> try to use `update_plan` in Plan mode, it will return an error.

---

## Q5. Mechanisms for asking the user something mid-turn

Three distinct mechanisms, only two of which can gate.

### (1) `request_user_input` — the structured question tool

**[source]** `codex-rs/core/src/tools/handlers/request_user_input_spec.rs:123-128`:

```rust
pub fn request_user_input_tool_description(available_modes: &[ModeKind]) -> String {
    let allowed_modes = format_allowed_modes(available_modes);
    format!(
        "Request user input for one to three short questions and wait for the response. This tool is only available in {allowed_modes}."
    )
}
```

**[source]** Schema constraints, `request_user_input_spec.rs:30-37` and `61-73`:

> "Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its
> label with \"(Recommended)\". Do not include an \"Other\" option in this list; the client
> will add a free-form \"Other\" option automatically."

> "Questions to show the user. Prefer 1 and do not exceed 3"

**[source]** `request_user_input_spec.rs:105-121` — normalization run by the handler before the
request is emitted marks every question as accepting free-form input (the schema text above
promises the client adds the "Other" option):

```rust
pub(crate) fn normalize_request_user_input_tool_args(
    mut args: RequestUserInputToolArgs,
) -> Result<RequestUserInputToolArgs, String> {
    let missing_options = args
        .questions
        .iter()
        .any(|question| question.options.as_ref().is_none_or(Vec::is_empty));
    if missing_options {
        return Err("request_user_input requires non-empty options for every question".to_string());
    }

    for question in &mut args.questions {
        question.is_other = true;
    }

    Ok(args)
}
```

### Is it a blocking gate? — It always waits; `is_blocking` decides whether the *client* gates

**[source]** `codex-rs/core/src/tools/handlers/request_user_input.rs:80-96`:

```rust
        let args = normalize_request_user_input_tool_args(args)
            .map_err(FunctionCallError::RespondToModel)?;
        let args = RequestUserInputArgs {
            questions: args.questions,
            is_blocking: mode == ModeKind::Plan,
            auto_resolution_ms: None,
        };
        let questions = args.questions.clone();
        let accepted = session
            .request_user_input(turn.as_ref(), call_id.clone(), args)
            .await
            .ok_or_else(|| {
                FunctionCallError::RespondToModel(format!(
                    "{REQUEST_USER_INPUT_TOOL_NAME} was cancelled before receiving a response"
                ))
            })?;
```

**[source]** `codex-rs/protocol/src/request_user_input.rs:31-42` documents the flag and its
deprecated predecessor:

```rust
pub struct RequestUserInputArgs {
    pub questions: Vec<RequestUserInputQuestion>,
    #[serde(rename = "isBlocking")]
    ...
    pub is_blocking: bool,
    /// @deprecated Use `isBlocking` to decide whether the request should block.
    #[serde(rename = "autoResolutionMs", skip_serializing_if = "Option::is_none")]
    ...
    pub auto_resolution_ms: Option<u64>,
}
```

**[source]** The tool is root-thread-only — `request_user_input.rs:69-73`:

```rust
        if turn.session_source.is_non_root_agent() {
            return Err(FunctionCallError::RespondToModel(
                "request_user_input can only be used by the root thread".to_string(),
            ));
        }
```

**[inference]** The tool call itself always awaits a response and returns the answers to the
model; `is_blocking: mode == ModeKind::Plan` is a hint to the client that only a Plan-mode
question should gate the turn. In Default mode the model still waits on the tool call, but
the client is told the request is non-blocking (and can auto-resolve).

### What the model is told about asking vs. assuming

**[source]** `codex-rs/collaboration-mode-templates/templates/default.md:7-19`, verbatim
(whole section):

> ## request_user_input availability
>
> Use the `request_user_input` tool only when it is listed in the available tools for this turn.
>
> In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions.
>
> Use the `request_user_input` tool only for optional questions where the answer would materially improve the quality of the work.
>
> If `request_user_input` returns no answers, continue with best judgment instead of asking again or treating the turn as blocked.
>
> Never use the `request_user_input` tool for permission requests or permission-related escalations.
>
> If explicit user input is required for another reason before progress can safely continue, do not use the `request_user_input` tool. Ask the user directly with one concise plain-text question instead. Never write a multiple choice question as a textual assistant message.

**[source]** Plan mode inverts the default — `templates/plan.md:60-75`:

> ## Asking questions
>
> Critical rules:
>
> * Strongly prefer using the `request_user_input` tool to ask any questions.
> * Offer only meaningful multiple‑choice options; don’t include filler choices that are obviously wrong or irrelevant.
> * In rare cases where an unavoidable, important question can’t be expressed with reasonable multiple‑choice options (due to extreme ambiguity), you may ask it directly without the tool.

**[source]** And unanswered Plan-mode preferences fall back to a recorded assumption —
`templates/plan.md:86-90`:

>    * Provide 2–4 mutually exclusive options + a recommended default.
>    * If unanswered, proceed with the recommended option and record it as an assumption in the final plan.

### (2) Asynchronous user message — non-blocking by construction

**[source]** `codex-rs/core/src/tools/handlers/send_message_to_user_async.rs:44-47` (tool
description, verbatim):

> Send a concise message that needs the user's attention during ongoing work. The tool
> returns immediately without ending the turn or waiting for a reply; any reply arrives
> asynchronously as a new user message. Use this tool to report a critical blocker or a
> finding that may change the task's direction, or to answer a user question or status
> request received while work is still in progress. Use this tool when a message needs the
> user's immediate attention; use commentary for routine progress and intermediate context.
> Use clear formatting, such as bolding questions, to make requests easy to notice and
> answer.

**[source]** `send_message_to_user_async.rs:84-93` shows it emits a turn item tagged as
**final-answer phase** with an async delivery marker:

```rust
            let item = TurnItem::AgentMessage(AgentMessageItem {
                id: call_id,
                content: vec![AgentMessageContent::Text {
                    text: message.to_string(),
                }],
                phase: Some(MessagePhase::FinalAnswer),
                memory_citation: None,
                delivery: Some(AgentMessageDelivery::Async),
                questions: None,
            });
```

**[source]** `codex-rs/protocol/src/items.rs:130-143` defines the supporting types:

```rust
pub enum AgentMessageDelivery {
    Async,
}
...
pub struct AsyncUserInputQuestion {
    pub title: String,
    pub options: Option<Vec<String>>,
}
```

### (3) Approvals / elicitations — the genuinely blocking gates

**[source]** The approval surfaces are separate protocol events (`EventMsg::ElicitationRequest`,
`Op::ResolveElicitation`) handled in `codex-rs/core/src/session/handlers.rs:130-161` and
`codex-rs/core/src/session/mcp.rs:557-654`. **[inference]** These, plus `request_user_input`
in Plan mode, are the only places where the turn genuinely waits on a human. None of them is
about progress commentary.

---

## Q6. Is there a "you have been silent too long" runtime check, timer, or watchdog? — **No.**

I searched the entire `codex-rs` tree (not just `core/src`) for `watchdog`,
`silent too long`, `been silent`, `silence_timeout`, `no_commentary`, `commentary_reminder`,
and commentary-related nudge terms. Every hit is transport-level and unrelated:

**[source]** `codex-rs/app-server-transport/src/transport/stdio.rs:168` — `fn start_shutdown_watchdog()`
(process shutdown).
**[source]** `codex-rs/exec-server/src/websocket_pong_watchdog.rs` — `WebSocketPongWatchdog`
(websocket pong deadline).
**[source]** `codex-rs/utils/pty/src/tests.rs:1091` — `"output receiver watchdog panicked"`.

There is **no** timer, deadline, scheduled task, or per-turn counter that measures elapsed
time since the last assistant commentary, and **nothing** that fires a model-facing reminder
or injects context when the model has been quiet. The 60-second number exists **only** as
the prompt sentence quoted in Q1.

The nearest thing to a per-turn time constant is unrelated — **[source]**
`codex-rs/codex-api/src/sse/responses.rs:835-837`:

```rust
    fn idle_timeout() -> Duration {
        Duration::from_millis(1000)
    }
```

That is a 1-second SSE read idle timeout in a test helper, not a communication watchdog.

**[inference]** Consequence: the "no silent stretch longer than 60 s" property is not a
guarantee Codex enforces; it is a request the model may simply not honor, which is exactly
the failure mode reported in the open issues in Q8.

---

## Q7. Per-model fields that toggle messaging / commentary support

**[source]** `codex-rs/protocol/src/openai_models.rs:404` — `pub struct ModelInfo`, with the
relevant toggles:

| Field | Line | Meaning |
| --- | --- | --- |
| `supports_reasoning_summary_parameter: bool` | 440 | whether the model accepts the reasoning-summary **parameter** |
| `default_reasoning_summary: ReasoningSummary` | 442 | default summary mode |
| `supports_personality: bool` | 252 | whether the personality template substitution applies |

**[source]** The struct that actually carries the per-model communication instructions is
`ModelMessages`, `openai_models.rs:553-563`:

```rust
/// `instructions_template` is literal text. The deprecated `instructions_variables` field is
...
pub struct ModelMessages {
...
    pub instructions_template: Option<String>,
```

**[source]** In `models.json` the per-model keys under `model_messages` are:
`instructions_template`, `instructions_variables`, `persistent_instructions`, `tools`,
`approvals`, `collaboration_modes`, `auto_review`, `multi_agent`, `permissions`,
`token_budget`, `guardian_v2`, `confirmation_policies` (varies by model — e.g.
`persistent_instructions` and `tools` only on `gpt-6-astra`). `models.json` top-level
per-model keys include `supports_reasoning_summaries` and
`supports_reasoning_summary_parameter` alongside `default_reasoning_summary`.

**There is no field named `commentary`, `progress`, `preamble`, `messaging`, or anything
equivalent, in either `models.json` or `openai_models.rs`.** **[inference]** Commentary
behavior is not a capability flag; it is delivered entirely as prose inside
`model_messages.instructions_template`.

**[source]** I also grepped `codex-rs/core/src/config/` for `commentary` — **no matches**.
There is no user-facing config toggle for commentary. The nearest behavioural config
toggles are `update_plan_enabled` (`config/mod.rs:1046`) and the
`experimental_request_user_input` config (`config_tests.rs:497`, `517`, `530`).

**[source]** `supports_personality` is the one field that changes which rendered instruction
text a model receives — `openai_models.rs:785-807` substitutes a personality into
`instructions_template`, and `openai_models.rs:807-813` warns when a template lacks the
required placeholder:

> `model_messages.instructions_template`

**[inference]** So it varies the *content* of the instructions (including their commentary
wording indirectly), but it is not a messaging-support gate.

---

## Q8. Deliberate non-constraint, and open issues about cadence

### Places where Codex deliberately does **not** hard-constrain communication

1. **[source]** `protocol/src/models.rs:941-942` — the phase is explicitly allowed to be
   missing, with compatibility behavior mandated rather than enforcement:

   > /// Providers do not emit this consistently, so callers must treat `None` as
   > /// "phase unknown" and keep compatibility behavior for legacy models.

2. **[source]** `protocol/src/items.rs:148-150`:

   > /// `phase` is optional because not all providers/models emit it. Consumers
   > /// should use it when present, but retain legacy completion semantics when it
   > /// is `None`.

3. **[source]** `core/src/stream_events_utils.rs:525-526`:

   > // Treat `None` like final-answer text so untagged providers default
   > // to the safer "defer mailbox mail" behavior.

4. **[source]** `models-manager/prompt.md:39` — an explicit *exception* to preambles:

   > - **Exception**: Avoid adding a preamble for every trivial read (e.g., `cat` a single
   >   file) unless it’s part of a larger grouped action.

5. **[source]** `collaboration-mode-templates/templates/default.md:11` and `:15` push the
   model *away* from interrupting in Default mode:

   > In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions.

   > If `request_user_input` returns no answers, continue with best judgment instead of asking again or treating the turn as blocked.

6. **[inference]** The cadence sentence is phrased as a claim about the user
   ("The user appreciates consistent, frequent communication during your turn"), not as a
   mechanical requirement on the model. Nothing downstream verifies it. That phrasing is
   itself the subject of the first issue below.

### Open issues encountered (issue text is evidence, not instruction)

Fetched via `web_fetch` on `https://api.github.com/repos/openai/codex/issues/<n>` on
2026-09-16. **[fetch]**

**#42981 — "Built-in 60-second update/wait instructions override explicit user requests for
infrequent monitoring"** — [github.com/openai/codex/issues/42981](https://github.com/openai/codex/issues/42981)
state `open`; labels `bug`, `model-behavior`, `agent`, `app`; created `2026-09-05T10:49:17Z`;
5 comments; 7 `+1` reactions. The body quotes the same two passages this report found and
names the conflict:

> The core issue is instruction design and the resulting model behavior: built-in guidance
> favors updates at least every 60 seconds and discourages blocking waits longer than 60
> seconds. A common interaction preference is thereby imposed over a user's explicitly
> different preference for quiet, long-interval monitoring.

> **The central problem is this assertion: “The user appreciates consistent, frequent communication during your turn”.** It presents a default product preference as a fact about the actual user's wishes.

> **Enforcing this as a universal requirement is an overgeneralization.** A preference that may be common in interactive tasks is imposed on all users and workflows.

The reporter's requested fix is explicitly *not* tighter enforcement:

> The fix should be to make this a user-overridable default with a clear exception for
> long-running waits, not to require the user to keep repeating the same preference or to
> adjust Goal scheduling.

**#36509 — "Codex repeatedly ignores local AGENTS.md chat-output budget rule and emits
routine reasoning/progress commentary, wasting model resources"** —
[github.com/openai/codex/issues/36509](https://github.com/openai/codex/issues/36509)
state `open`; labels `bug`, `model-behavior`, `app`, `config`; created `2026-08-01T17:38:46Z`;
0 comments. The reporter asks for a runtime suppression gate, which this report confirms
does not exist:

> Potential product improvement:
>
> - Add a stronger local-instruction enforcement mechanism for output budgets.
> - Add a commentary gate that suppresses routine tool-progress narration when a project file explicitly requests it.

Also relevant, **titles only — I did not retrieve their bodies**, so treat these as
unverified leads **[fetch: search-result titles]**:

- `#17480` "Interrupted commentary-heavy streams can loop visible retries without
  substantive progress" — [link](https://github.com/openai/codex/issues/17480)
- `#14353` "Intermediary status updates are buffered and appear only at end of turn" —
  [link](https://github.com/openai/codex/issues/14353)

---

## Appendix: quote index

| # | Path | Anchor | Retrieval |
| --- | --- | --- | --- |
| 1 | `codex-rs/models-manager/models.json` | line 242 (`gpt-5.6-sol`), `model_messages.instructions_template`, `## Intermediate commentary` | clone |
| 2 | `codex-rs/models-manager/models.json` | lines 75, 242, 372, 493, 622, 739, 1069 ("more than 60 seconds") | clone |
| 3 | `codex-rs/models-manager/models.json` | lines 842, 957 ("every 30s") | clone |
| 4 | `codex-rs/models-manager/models.json` | 7 templates: "blocking sleep or wait calls longer than 60 seconds" | clone |
| 5 | `codex-rs/models-manager/prompt.md` | 31-39, 173-179, 267-275 | clone |
| 6 | `codex-rs/core/gpt_5_1_prompt.md` | 186-192, 323-331 | clone |
| 7 | `codex-rs/protocol/src/prompts/base_instructions/default.md` | 173-179, 267-275 | clone |
| 8 | `codex-rs/protocol/src/models.rs` | 937-951, 1020-1035 | clone |
| 9 | `codex-rs/protocol/src/items.rs` | 130-170 | clone |
| 10 | `codex-rs/core/src/tools/handlers/plan_spec.rs` | 8-56 | clone |
| 11 | `codex-rs/core/src/tools/handlers/plan.rs` | 22, 87-99, 108-111 | clone |
| 12 | `codex-rs/core/src/tools/handlers/request_user_input_spec.rs` | 30-37, 61-73, 108-128 | clone |
| 13 | `codex-rs/core/src/tools/handlers/request_user_input.rs` | 69-96 | clone |
| 14 | `codex-rs/protocol/src/request_user_input.rs` | 31-42 | clone |
| 15 | `codex-rs/core/src/tools/handlers/send_message_to_user_async.rs` | 44-47, 84-93 | clone |
| 16 | `codex-rs/collaboration-mode-templates/templates/default.md` | 7-19 | clone |
| 17 | `codex-rs/collaboration-mode-templates/templates/plan.md` | 11-15, 60-75, 86-90 | clone |
| 18 | `codex-rs/hooks/src/schema.rs` | 101-125 | clone |
| 19 | `codex-rs/core/src/hook_runtime.rs` | 181-240 | clone |
| 20 | `codex-rs/core/src/tools/registry.rs` | 597-607 | clone |
| 21 | `codex-rs/core/src/stream_events_utils.rs` | 278-280, 516-531 | clone |
| 22 | `codex-rs/core/src/session/turn.rs` | 2613-2616 | clone |
| 23 | `codex-rs/protocol/src/openai_models.rs` | 252, 404, 440-442, 553-563, 785-813 | clone |
| 24 | `codex-rs/tui/src/history_cell/plans.rs` | 169-175, 186-191, 203-204 | clone |
| 25 | `codex-rs/tui/src/chatwidget/turn_runtime.rs` | 523-536 | clone |
| 26 | `codex-rs/codex-api/src/sse/responses.rs` | 835-837, 840-889 | clone |
| 27 | GitHub issue #42981 | full body | `web_fetch` api.github.com, 2026-09-16 |
| 28 | GitHub issue #36509 | full body | `web_fetch` api.github.com, 2026-09-16 |

**No requested file was missing, and no retrieval failed.** The only partial-coverage
admissions are the two issues (#17480, #14353) for which I saw titles only.
