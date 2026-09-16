/**
 * Pure disclosure policy.
 *
 * This module deliberately imports nothing from the host so the complete
 * behavior — silence accounting, reminder arming, and post-execute composition —
 * can be unit-tested without the DeepSeek Harness dependency graph. `index.ts`
 * is only the adapter that binds these decisions to Cordis extension points.
 */
/** Package/plugin identity carried by every notice this policy emits. */
export const DISCLOSURE_PLUGIN_NAME = 'disclosure-policy';
/**
 * Static system-prompt order for the standing disclosure policy: after the
 * first-party Web-surface guidance (`WEB_SURFACE = 10100`) and before the
 * deployment persona suffix (`DEPLOYMENT_PERSONA_SUFFIX = 10200`).
 */
export const DISCLOSURE_POLICY_ORDER = 10150;
/** Prompt-section name; unique within its layer. */
export const DISCLOSURE_POLICY_SECTION_NAME = 'plugin:disclosure-policy:policy';
export const DEFAULT_CONFIG = Object.freeze({
    reminderAfterCalls: 8,
});
/**
 * Resolve and validate the single behavioral option. The schema in `index.ts`
 * already rejects malformed DSH config rows; this second check keeps the pure
 * module authoritative and fails closed for direct callers.
 */
export function resolveConfig(input = {}) {
    const reminderAfterCalls = input.reminderAfterCalls ?? DEFAULT_CONFIG.reminderAfterCalls;
    if (!Number.isSafeInteger(reminderAfterCalls) || reminderAfterCalls < 0) {
        throw new Error('disclosure-policy: reminderAfterCalls must be a non-negative safe integer');
    }
    return Object.freeze({ reminderAfterCalls });
}
/**
 * True when any visible `text` block carries a non-whitespace character.
 *
 * Reasoning blocks are not disclosure, and an empty or whitespace-only text
 * block is not a message the supervisor can read.
 */
export function hasVisibleText(content) {
    return content.some(block => block.type === 'text'
        && typeof block.text === 'string'
        && block.text.trim() !== '');
}
/**
 * True when one committed message opens a new silence interval: assistant text
 * authored by the routed model. Reasoning-only messages, tool results, and
 * plugin-authored context never reset the interval.
 */
export function isModelDisclosure(message) {
    if (message.role !== 'assistant')
        return false;
    if (message.source?.kind !== 'model')
        return false;
    return hasVisibleText(message.content);
}
/** The state of a freshly opened interval; the single source of the reset values. */
const OPEN_INTERVAL = Object.freeze({ calls: 0, reminded: false });
/** `turn/start` initializes the interval. */
export function createSilence() {
    return { ...OPEN_INTERVAL };
}
/**
 * Open a new interval in place: visible model text (or a new turn) clears the
 * call count and re-arms the single reminder, without replacing the record.
 */
export function resetSilence(state) {
    Object.assign(state, OPEN_INTERVAL);
    return state;
}
/**
 * Count one completed top-level call and report whether it carries the
 * interval's single reminder.
 *
 * Nested calls inside a composite tool never count. The reminder does not reset
 * the count, and a silence interval is reminded at most once, so a parallel step
 * can produce at most one notice. The result is independent of whether the call
 * succeeded, failed, or was denied by another policy, because every settled call
 * reaches the caller exactly once.
 */
export function countCompletedCall(state, reminderAfterCalls, options = {}) {
    if (options.nested === true)
        return false;
    state.calls += 1;
    if (reminderAfterCalls <= 0 || state.reminded)
        return false;
    if (state.calls < reminderAfterCalls)
        return false;
    state.reminded = true;
    return true;
}
/**
 * Compose one reminder into a downstream `tools/post-execute` decision.
 *
 * The decision is preserved rather than replaced: its kind and every other
 * field survive, our notice goes first, and contexts the downstream listener
 * supplied stay after ours.
 */
export function withReminder(decision, reminder) {
    const existing = decision.additionalContexts;
    const additionalContexts = existing === undefined ? [reminder] : [reminder, ...existing];
    // The spread keeps every downstream field; only the context list is extended.
    return { ...decision, additionalContexts };
}
/**
 * The standing policy installed at {@link DISCLOSURE_POLICY_ORDER}.
 *
 * It states the semantic obligation — when disclosure is worth sending and what
 * it should answer — and nothing else. It carries no runtime state, no cadence,
 * and no enforcement.
 */
export const DISCLOSURE_POLICY_TEXT = [
    '## Disclosure',
    '',
    'You are executing a settled execution brief. Work autonomously, and disclose briefly whenever there is material new information for the supervisor, especially after:',
    '',
    '- confirming a finding;',
    '- completing a meaningful phase;',
    '- changing the settled plan or departing from a settled constraint;',
    '- obtaining a verification result;',
    '- encountering a blocker or material uncertainty; or',
    '- preparing to enter a clearly long stretch of work.',
    '',
    'A useful disclosure answers only what is relevant:',
    '',
    '1. What is now confirmed?',
    '2. Did this change the settled plan or the settled constraints?',
    '3. What happens next, and is there anything worth the supervisor’s intervention?',
    '',
    'Do not open with a preamble. Ask the user a question only when the execution brief does not let you continue; otherwise keep working and disclose. Never expose private chain-of-thought.',
].join('\n');
/**
 * The one soft reminder, delivered as next-step context through
 * `tools/post-execute`.
 *
 * It asks for the same three answers as the standing policy in one or two
 * sentences. It is purely an instruction: no runtime fact row, no threat of
 * denial, no request for user input, and no chain-of-thought request.
 */
export const DISCLOSURE_REMINDER_TEXT = [
    '[disclosure] Before continuing this long stretch of tool work, send one or two concise sentences of visible disclosure: what is now confirmed, whether the settled plan or constraints changed, and what happens next — including anything worth the supervisor’s intervention.',
    'Then keep working autonomously; do not wait for a reply.',
].join(' ');
