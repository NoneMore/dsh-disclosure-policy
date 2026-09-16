# Codex interaction practices: what to port into DeepSeek Harness

**Research snapshot:** 2026-09-16  
**Scope:** OpenAI Codex public repository `main` plus clearly labeled issue/discussion evidence.  
**Purpose:** extract interaction patterns that improve long-running agent UX, then map them onto DSH without pretending Codex internals are DSH contracts.

This note is intentionally more detailed than `PRACTICES.md`. It focuses on one question: **why does Codex tend to feel more communicative during long work, and which parts can be reproduced cleanly in DSH?**

The short answer is that Codex does not rely on one mechanism. It combines:

1. a model-facing communication policy;
2. an explicit protocol distinction between mid-turn commentary and final answers;
3. structured plan state that is separate from narration;
4. structured user-question / approval paths rather than overloading progress text;
5. UI/protocol support that preserves those distinctions;
6. runtime fallbacks, model-specific instructions, and host-specific tools that continue evolving.

The most important lesson for this plugin is: **communication is a first-class work product, but it should stay separate from planning, private reasoning, and blocking user decisions.**

---

## 1. Source hierarchy and caveat: there is no single immutable “Codex prompt”

Codex behavior is model- and surface-dependent. The public repository currently contains several relevant instruction sources:

- Current model catalog / model-specific instruction templates:  
  https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json
- Model-manager prompt with explicit preamble and planning guidance:  
  https://github.com/openai/codex/blob/main/codex-rs/models-manager/prompt.md
- GPT-5.1-oriented prompt with `User Updates Spec` and plan-maintenance guidance:  
  https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_1_prompt.md
- Base instruction defaults:  
  https://github.com/openai/codex/blob/main/codex-rs/protocol/src/prompts/base_instructions/default.md

These files overlap but are not identical. For example, the current model catalog contains variants that say an active tool-using turn should not go more than roughly **60 seconds** without commentary, while the GPT-5.1 prompt describes “reasonable intervals” and emphasizes semantic transitions. Therefore:

- treat **semantic reporting** as the stable design principle;
- treat **exact time/call thresholds** as product/model tuning, not an eternal Codex invariant;
- do not cargo-cult a historical 20-second/60-second number into DSH without giving users a way to tune or disable it.

Community-captured prompt dumps can be useful historical evidence, but they are weaker than current repository sources and are not used here as normative contracts.

---

## 2. Codex separates commentary from final answers at protocol level

Primary source:

- `MessagePhase` in protocol models:  
  https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs
- Turn item representation:  
  https://github.com/openai/codex/blob/main/codex-rs/protocol/src/items.rs

Codex defines an optional message phase with two meanings:

- `commentary`: interim assistant text; more tool calls or assistant output may follow;
- `final_answer`: terminal answer text for the current turn.

The important architectural property is not the enum itself. It is that **user-visible text is allowed to be a non-terminal event**. That makes this sequence normal:

```text
user request
  ↓
commentary: first-step / preamble
  ↓
tools...
  ↓
commentary: concrete finding + next action
  ↓
tools...
  ↓
commentary: verification result
  ↓
tools...
  ↓
final answer
```

### DSH mapping

DSH does not need to clone `MessagePhase`. Its native `assistant/message` events and Web Turn projection already support reply-bearing Assistant material before the final answer. The plugin should therefore **cause the model to use DSH's existing mid-turn Assistant channel**, not create a second transcript system.

### Important portability lesson

If a host or transport drops the distinction between interim and final text, user experience degrades. Codex issue #30190 documents exactly this type of problem for an exec/SDK path that discarded phase metadata even though upstream protocol had it:

https://github.com/openai/codex/issues/30190

For DSH integrations, preserve at least this semantic distinction even if the wire format differs:

```text
visible assistant text while turn is still active
vs.
terminal answer after turn completion
```

---

## 3. Commentary is not “show the chain-of-thought”

Primary sources:

- Current model catalog instructions:  
  https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json
- `MessagePhase` definition:  
  https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs

Codex treats commentary as **user communication**, not private reasoning. Current instructions describe commentary as a place for concise, meaningful updates such as:

- assumptions that matter to execution;
- findings;
- decisions;
- changes in direction;
- immediate next actions.

That is the right abstraction for DSH as well. A progress update should summarize externally useful state, not expose hidden reasoning traces.

### DSH rule to preserve

Good:

```text
The failing path is isolated to workspace-scoped cache keys. I’m patching the key construction now, then I’ll run the cross-workspace regression test.
```

Bad:

```text
I am continuing to think through the problem and checking more files.
```

Also bad:

```text
Here is my full internal reasoning for why I chose this implementation...
```

The current plugin therefore resets its communication freshness budget only on visible Assistant `text`, never on reasoning blocks.

---

## 4. Codex uses both semantic triggers and a liveness expectation

Primary sources:

- GPT-5.1 `User Updates Spec`:  
  https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_1_prompt.md
- Current model catalog `Intermediate commentary`:  
  https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json

Two ideas appear repeatedly:

### 4.1 Semantic triggers

Useful updates happen when something **materially changes**, for example:

- a meaningful phase finishes;
- a discovery changes the implementation direction;
- a test or verification produces a meaningful result;
- the plan changes;
- a blocker appears;
- the agent is about to enter another substantial stretch of latency-producing work.

This is better than mechanically narrating every command.

### 4.2 Liveness / maximum silence

Current model-catalog instructions for several models also say a tool-using turn should begin with commentary and should not leave the user without an update for more than about 60 seconds during ongoing work.

This is a **fallback liveness policy**, not a substitute for semantic value. Codex itself has an open issue (#42981) arguing that a built-in 60-second expectation can conflict with a user who explicitly asked for quiet, long-interval monitoring:

https://github.com/openai/codex/issues/42981

### DSH adaptation

Use two layers:

```text
semantic event → report now
no semantic event for a long time → freshness fallback
```

This plugin currently implements a tool-call-count fallback because it can observe tool activity cheaply and deterministically. A future wall-clock fallback should be configurable and should not claim it can interrupt a single long blocking tool invocation.

---

## 5. Preambles are grouped, concise, and tied to the next real action

Primary source:

- Model-manager preamble guidance:  
  https://github.com/openai/codex/blob/main/codex-rs/models-manager/prompt.md
- GPT-5.1 progress guidance:  
  https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_1_prompt.md

Codex's public guidance is more specific than “say something before tools.” It asks the model to:

- group related actions into one preamble;
- keep it to about one or two sentences;
- connect it to prior progress when this is not the first tool batch;
- explain the immediate tangible next step;
- avoid adding a preamble for every trivial single read.

This avoids the worst version of “interactive” agents: one line of narration before every command.

### DSH adaptation

A future optional **initial-update gate** could require one substantive Assistant message before the first ordinary tool call of a long turn. It should still allow the model to put text and the first tool call in the same assistant response, because DSH commits `assistant/message` before dispatching that response's tools.

Recommended rule:

```text
first substantial tool batch
  → one concise preamble

trivial follow-up reads inside the same phase
  → no extra preamble required

new phase / changed plan / expensive edit or test batch
  → another concise update
```

---

## 6. Plan state and progress narration are deliberately different products

Primary sources:

- `update_plan` tool schema:  
  https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/plan_spec.rs
- Planning guidance:  
  https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_1_prompt.md
- Model-manager planning guidance:  
  https://github.com/openai/codex/blob/main/codex-rs/models-manager/prompt.md

Codex exposes structured plan items with statuses such as:

```text
pending
in_progress
completed
```

The model instructions separately tell it to narrate progress to the user. This is important because these artifacts answer different questions:

- plan: **what units of work exist and which one is active?**
- commentary: **what did we learn, decide, or verify, and what is next?**

Codex planning guidance also contains several maintenance principles that are directly relevant to the DSH stale-TODO problem:

- keep one active item at a time where appropriate;
- move status forward while working;
- do not let the plan become stale;
- explain a real plan change;
- do not repeat the entire plan after every update because the UI already renders it.

### DSH adaptation

Keep plan state and communication genuinely separate. v0.2 implemented that as two runtime lanes with
their own counters; v0.3 keeps only the communication lane and leaves task accounting entirely to
`todo_write`:

```text
task accounting         → todo_write, owned by a separate concern
communication freshness → visible assistant message
```

Do **not** let `todo_write` reset the communication counter. A machine-readable state change is not the same thing as telling the human what was discovered.

Do **not** let a chatty progress message reset TODO freshness. The plan can still be stale even when the model talks frequently.

---

## 7. Final answers are intentionally self-contained

Primary source:

- Current model catalog:  
  https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json

Current Codex instructions explicitly say the final answer should be self-contained because intermediate commentary may be collapsed after completion.

This prevents a subtle failure mode:

```text
mid-turn: explains important test failure
mid-turn: explains changed implementation choice
final: “Done.”
```

A user reopening the completed task should not have to expand process history to understand the result.

### DSH adaptation

The plugin should encourage mid-turn visibility **without weakening final delivery**. The final response should still summarize:

- actual outcome;
- material changes/decisions;
- verification performed and failures that remain;
- unfinished or deferred work.

The final answer is not another progress checkpoint; it is the durable close-out.

---

## 8. Blocking user decisions should not be disguised as progress narration

Primary sources:

- Current model catalog and async-question guidance:  
  https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json
- Structured blocking question tool:  
  https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input_spec.rs
- Collaboration-mode default policy:  
  https://github.com/openai/codex/blob/main/codex-rs/collaboration-mode-templates/templates/default.md

Codex has explicit user-question mechanisms rather than requiring all interaction to be plain commentary. The synchronous `request_user_input` tool is described as waiting for the response; newer surfaces/model entries also expose asynchronous user-input/message concepts.

The UX principle is more important than the exact tool names:

```text
progress update   = FYI; work can continue
optional question = answer improves work, but independent work can continue
required decision = dependent work must wait
approval           = explicit authorization boundary
```

### DSH adaptation

Use DSH's native user-question/approval facilities for decisions. A progress guard should never convert this:

```text
“I need you to choose schema A or B before I can migrate production data.”
```

into a non-blocking status sentence followed by unilateral execution.

Similarly, do not trigger a blocking question merely because the communication freshness counter is stale. The checkpoint should ask the **model to report**, not ask the **user to decide**, unless a real decision is already required.

---

## 9. Async user-facing messages show a deeper separation between “send update” and “end turn”

Primary sources:

- Current model catalog persistent-mode instructions and tool metadata:  
  https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json
- Protocol item fields `delivery` / `AgentMessageDelivery::Async`:  
  https://github.com/openai/codex/blob/main/codex-rs/protocol/src/items.rs
- App-server delivery handling:  
  https://github.com/openai/codex/blob/main/codex-rs/app-server/src/in_process.rs

Newer Codex model metadata includes `send_user_message_async` for some persistent workflows. Its prompt logic explicitly distinguishes:

- sending useful user-visible information while work remains;
- sending `final`, which ends the turn.

This is stronger than merely classifying normal assistant text as commentary. It makes “communicate without finishing” an explicit action in some modes.

### DSH adaptation

DSH already permits ordinary mid-turn Assistant text, so this plugin does not need a cloned async-message tool just to get narration. But the Codex design reinforces a useful abstraction:

> **yielding information to the human and terminating execution are separate operations.**

If DSH later adds persistent/background workflows, a first-class async user-message primitive may become useful for delivery guarantees and UI lifecycle, but it is not necessary for the current foreground Turn problem.

---

## 10. New user messages during active work are control input, not just transcript text

Primary source:

- Current model catalog user-interaction instructions:  
  https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json

Codex's current instructions explicitly discuss a user sending another message while work is still in progress and require the agent to decide whether it:

- replaces/overrides the active request;
- adds to the unfinished request;
- asks only for status.

This is a key reason progress narration matters: the human needs enough context to know when to intervene, and the agent must then treat the intervention as active control input.

### DSH adaptation

Keep these UI concepts separate:

```text
Observe → read progress / runtime state
Ask     → side question that does not alter execution
Steer   → change the active direction
Stop    → terminate work
Approve → explicit gate
```

A progress plugin improves **Observe**. It should make **Steer** easier to use, not silently reinterpret every user message as steering.

---

## 11. Compaction / resume behavior is part of interaction quality

Primary source:

- Current model catalog:  
  https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json

Codex instructions repeatedly tell the model to treat compaction/resume as one logical chain of work: do not restart from scratch, do not repeat completed work, and do not replay commentary that was already delivered.

This matters because long agent runs inevitably cross context-management boundaries. A progress system that is perfect for the first context window but repeats itself or loses state after compaction still feels unreliable.

### DSH adaptation

The plugin's counters are intentionally runtime-local today, but durable task state (`todo_write`) and transcript state remain in the DSH session. A future richer checkpoint state should either:

- be reconstructible from durable DSH events; or
- be explicitly marked as ephemeral observability state rather than semantic task truth.

Do not introduce a second hidden progress database unless it has a clear replay/resume contract.

---

## 12. Codex exposes reasoning summaries separately from user-facing commentary

Primary source:

- Model metadata includes reasoning-summary capabilities independently of commentary instructions:  
  https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json
- Shared model metadata:  
  https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs

This reinforces the conceptual split:

```text
reasoning / reasoning summary
    ≠
user-facing progress commentary
```

A DSH UI may choose to expose reasoning or a reasoning summary, but that should not be the only way a human learns whether the task changed direction. The model should still explicitly communicate decisions and externally relevant findings.

---

## 13. What not to copy blindly from Codex

### 13.1 Do not hard-code one universal time cadence

Current Codex prompt variants differ, and issue #42981 demonstrates that an unconditional 60-second rule can conflict with explicit user preferences.

For DSH, a cadence should be configurable, and “quiet mode” should remain possible.

### 13.2 Do not require narration before every trivial tool

Codex's preamble guidance explicitly groups related actions and exempts trivial reads from needless chatter. A per-command narration guard would optimize for message count rather than human comprehension.

### 13.3 Do not make plan updates user-facing duplicates

Codex tells the model not to repeat the full plan after `update_plan`; the UI already renders it. DSH should similarly avoid a progress message that merely paraphrases all TODO rows.

### 13.4 Do not make commentary the approval mechanism

Decisions and permissions need explicit interaction semantics. Narration is informational.

### 13.5 Do not assume every Codex surface preserves phase metadata perfectly

Issue #30190 is a useful warning that an integration can accidentally flatten commentary and final answers. Preserve semantic fidelity end-to-end in DSH clients/transports.

---

## 14. Recommended Codex-inspired DSH policy stack

The closest portable architecture is:

```text
Layer 1: standing model policy
  - begin substantial tool work with a concise preamble
  - report concrete findings / phase transitions / plan changes
  - avoid empty “still working” updates
  - keep final answer self-contained

Layer 2: structured task state
  - todo_write is maintained independently
  - current task state is visible without parsing prose

Layer 3: freshness fallback
  - tool-count and/or wall-clock silence budget
  - soft reminder first
  - hard checkpoint later (v0.3 deliberately stops at the reminder)

Layer 4: semantic triggers
  - test result changed
  - plan changed
  - blocker appeared
  - TODO phase finished
  - expensive work batch about to start

Layer 5: human control
  - Ask / Steer / Approve / Stop are distinct

Layer 6: runtime observability
  - current tool, elapsed time, stale counters, waiting state
  - does not depend on model compliance
```

This plugin currently implements most of Layers 1–3 for TODO and commentary freshness. Layers 4–6 are the natural next steps.

---

## 15. Concrete changes worth considering for the next DSH plugin version

### A. Optional initial-preamble gate

Add a configurable rule such as:

```text
requireInitialProgress: true
```

On a new Turn, the first ordinary tool call would be allowed only if the same assistant response already contained substantive visible text. DSH's event order makes this implementable without a synthetic message.

Why it matches Codex: current Codex model instructions explicitly say tool-using work should begin with commentary.

Why it should be optional: some users prefer minimal narration, and some trivial tool turns do not warrant a preamble.

### B. Configurable wall-clock fallback

Keep the N-call budget but add an optional wall-clock signal such as:

```text
progressReminderAfterSeconds
progressBlockAfterSeconds
```

Important limitation: a host cannot force narration **during** a single blocking tool call unless the runtime has a separate interrupt/heartbeat mechanism. Time-based enforcement can only take effect at the next observable boundary.

### C. Semantic event scoring

Instead of lowering fixed thresholds, request an update immediately after high-value events:

```text
plan changed                    +high
TODO item completed             +medium
verification failed             +high
verification passed after fail  +high
new blocker                     +high
large edit batch about to start +medium
ordinary read                   +low
```

The score should decide **whether to request narration**, not generate narration itself.

### D. User-configurable verbosity/cadence modes

For example:

```text
quiet      → semantic-only + large failsafe
balanced   → semantic + normal failsafe
verbose    → initial preamble + tighter liveness budget
```

This avoids the mistake of treating one Codex cadence as universally desirable.

### E. Final self-contained close-out check

A bounded turn-stop reminder can ask the model to ensure the final answer includes outcome + verification + remaining work, without forcing it to repeat all mid-turn commentary.

---

## 16. Source map

### Primary official Codex sources

1. Current model catalog / model-specific instructions  
   https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json  
   Establishes current commentary/final interaction guidance for multiple model entries, current model capabilities, async messaging metadata, reasoning-summary support, and the roughly-60-second liveness wording present in several instruction templates.

2. Model-manager prompt  
   https://github.com/openai/codex/blob/main/codex-rs/models-manager/prompt.md  
   Establishes grouped preamble guidance and plan-maintenance guidance.

3. GPT-5.1 prompt  
   https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_1_prompt.md  
   Establishes `User Updates Spec`, concise progress updates, pre-latency updates, and strong plan freshness rules.

4. `MessagePhase`  
   https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs  
   Establishes protocol-level commentary vs final-answer semantics and documents that provider phase metadata can be absent.

5. Agent message item  
   https://github.com/openai/codex/blob/main/codex-rs/protocol/src/items.rs  
   Shows `phase`, optional async delivery, and question metadata on user-visible assistant items.

6. `update_plan` schema  
   https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/plan_spec.rs  
   Establishes structured plan states and at-most-one-in-progress tool-level schema constraint.

7. Base `update_plan` instructions  
   https://github.com/openai/codex/blob/main/codex-rs/protocol/src/prompts/base_instructions/default.md  
   Establishes the base plan-maintenance contract shipped in public source.

8. Structured blocking user input tool  
   https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input_spec.rs  
   Establishes an explicit wait-for-user structured question path.

9. Default collaboration-mode question policy  
   https://github.com/openai/codex/blob/main/codex-rs/collaboration-mode-templates/templates/default.md  
   Shows that question behavior is mode/policy dependent and that Codex prefers autonomous reasonable assumptions in Default mode.

10. Current shared model metadata  
    https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs  
    Shows model-level metadata for messaging and reasoning-summary capabilities.

11. App-server async delivery handling  
    https://github.com/openai/codex/blob/main/codex-rs/app-server/src/in_process.rs  
    Shows async agent-message delivery is treated specially by the server transport.

### Secondary issue evidence / sharp edges

12. Exec/SDK phase fidelity gap #30190  
    https://github.com/openai/codex/issues/30190  
    Useful warning: a downstream surface can accidentally discard commentary-vs-final metadata.

13. Fixed 60-second update policy conflict #42981  
    https://github.com/openai/codex/issues/42981  
    Useful warning: liveness cadence should respect explicit user preferences rather than becoming an unconfigurable rule.

14. Async structured question opt-out / host ownership #43821  
    https://github.com/openai/codex/issues/43821  
    Useful warning: embedding hosts need explicit control over interaction primitives their UI actually supports.

15. Default-mode structured question gap #44833  
    https://github.com/openai/codex/issues/44833  
    Useful example of why informational commentary and blocking decision UI are separate interaction problems.

---

## 17. Bottom line for this DSH plugin

The part worth copying from Codex is **not** “print a status line every N seconds.” It is the layered contract:

```text
communicate before disappearing into substantial work
+ report material discoveries and direction changes
+ keep structured plan state fresh
+ use explicit decision/approval mechanisms when human input is required
+ keep final delivery self-contained
+ retain a liveness fallback so the model cannot stay silent indefinitely
```

DSH already has the transcript mechanics required for the first two points. The plugin's job is mainly to add the missing **communication obligation and bounded enforcement**, while leaving plan state, user decisions, private reasoning, and final delivery as separate concepts.
