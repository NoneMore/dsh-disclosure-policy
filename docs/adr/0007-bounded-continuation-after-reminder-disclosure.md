# Repair reminder-triggered disclosure-only turn stops with one bounded continuation

Status: proposed for review (2026-09-26)

A real exported session exposed a failure that the existing unit tests did not cover. A disclosure reminder arrived after a long stretch of tool work. The model then deliberately chose to make the next assistant response a standalone four-line disclosure and reasoned that the following work would happen in a "next turn". The provider returned `stop`; DSH correctly reached `agent/turn-stopping` and then closed the turn as completed. No next turn is created merely because the disclosure's `Next:` field names more work.

This is not a tool deadlock. It is a protocol mismatch: the plugin asks for an interim checkpoint but a normal assistant response is also a legal terminal response.

## Decision

Use two complementary protections.

1. The standing policy and reminder explicitly say that disclosure is a **progress checkpoint, not a turn boundary**. When executable work remains, the four disclosure lines stay the only visible prose in that assistant message and the model should issue the next necessary tool call(s) in the same message.
2. Add one narrow `agent/turn-stopping` repair. It steers exactly one extra step per turn only when all of the following are true:
   - this plugin delivered a reminder in the current disclosure interval;
   - a later model-authored assistant message satisfied the exact four-line disclosure recognizer;
   - that disclosure message contained no tool call; and
   - the turn is now naturally stopping.

The steering notice tells the model to execute the stated next action if it is executable, but to respond normally if the task is complete or blocked. It does not require another disclosure.

## Why the trigger is narrow

Steering every stop after any disclosure would turn a supervision aid into a general continuation policy. It could add unnecessary paid steps for legitimate completion or blockers. Restricting the repair to a disclosure that follows a runtime reminder ties the continuation directly to behavior this plugin itself induced.

A disclosure that already contains a tool call needs no repair. A spontaneous disclosure without a prior reminder is left to the standing policy. Ordinary final answers are not recognized disclosures and are never steered by this mechanism.

## Bound

The repair is limited to one `agent.steer(...)` per turn. If the model stops again, the turn may close. This prevents an unbounded paid loop and preserves the plugin's best-effort character.

## Consequences

- The plugin now uses three runtime seams: `session/event`, `tools/post-execute`, and `agent/turn-stopping`.
- The previous blanket statement that the plugin "never forces another step" is no longer true. It may force one narrowly conditioned continuation step.
- No tool call is denied, task state is not rewritten, and disclosure content is still model-authored.
- The strict four-visible-line recognizer remains unchanged. The preferred continuation shape is four visible disclosure lines plus tool-call blocks in the same assistant message.
- A reminder-triggered standalone disclosure that truly represents completion or a blocker can incur one extra model step; the continuation notice explicitly allows the model to finish or report the blocker normally.
- A spontaneous disclosure can still terminate a turn. That residual risk is accepted for now because the runtime cannot determine from unrestricted `Next:` prose whether more executable work really remains without adding semantic judgment.

## Verification target

The runtime regression suite must cover:

- reminder → standalone recognized disclosure → stop: exactly one steer;
- a second stop in the same turn: no second steer;
- recognized disclosure without a prior reminder: no steer;
- reminder → recognized disclosure with a tool call: no steer.
