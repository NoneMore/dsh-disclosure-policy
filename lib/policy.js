/**
 * Pure disclosure policy.
 *
 * This module deliberately imports nothing from the host so the complete
 * behavior — silence accounting, reminder cadence, budget, and post-execute
 * composition — can be unit-tested without the DeepSeek Harness dependency
 * graph. `index.ts` is only the adapter that binds these decisions to Cordis
 * extension points.
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
    maxReminders: 3,
});

const OPEN_ACTIVITY = Object.freeze({ inspect: 0, mutate: 0, verify: 0, other: 0 });
const INSPECT_TOKENS = new Set([
    'browse', 'diff', 'fetch', 'find', 'glob', 'grep', 'inspect', 'list', 'log', 'open', 'read', 'search', 'show', 'status',
]);
const MUTATE_TOKENS = new Set([
    'apply', 'copy', 'create', 'delete', 'edit', 'mkdir', 'move', 'patch', 'remove', 'rename', 'touch', 'update', 'write',
]);
const VERIFY_TOKENS = new Set([
    'acceptance', 'benchmark', 'build', 'check', 'lint', 'pytest', 'test', 'typecheck', 'validate', 'validation', 'verify',
]);
/** Coarse activity counters for one visible-text interval. */
export function createActivity() {
    return { ...OPEN_ACTIVITY };
}
/** Visible model text opens a new activity interval alongside the silence interval. */
export function resetActivity(state) {
    Object.assign(state, OPEN_ACTIVITY);
    return state;
}
/**
 * Classify one tool by its structured name only.
 *
 * This intentionally stays conservative: generic shells and composite transports
 * are `other`; their nested native tools can still contribute their own activity.
 */
export function classifyToolActivity(toolName) {
    const tokens = toolName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (tokens.some(token => VERIFY_TOKENS.has(token)))
        return 'verify';
    if (tokens.some(token => MUTATE_TOKENS.has(token)))
        return 'mutate';
    if (tokens.some(token => INSPECT_TOKENS.has(token)))
        return 'inspect';
    return 'other';
}
/** Count one completed tool operation in the current activity interval. */
export function recordActivity(state, kind) {
    state[kind] += 1;
    return state;
}
/**
 * Objective context for an inspection-only stretch, or `null` when the shape
 * is not notable enough to add to the normal disclosure reminder.
 *
 * The fact does not say the work is excessive or unproductive. It only reports
 * the observed tool mix and asks the model to name the unresolved fact that
 * justifies more investigation.
 */
export function inspectionActivityFact(state, minimumInspections) {
    if (minimumInspections <= 0
        || state.inspect < minimumInspections
        || state.mutate !== 0
        || state.verify !== 0) {
        return null;
    }
    return `This stretch has included ${state.inspect} inspection/search tool operations and no mutation-oriented or verification-oriented tool operations. If more investigation is still needed, identify the unresolved fact it is intended to settle.`;
}
/**
 * Resolve and validate the two behavioral options. The schema in `index.ts`
 * already rejects malformed DSH config rows; this second check keeps the pure
 * module authoritative and fails closed for direct callers.
 */
export function resolveConfig(input = {}) {
    const reminderAfterCalls = input.reminderAfterCalls ?? DEFAULT_CONFIG.reminderAfterCalls;
    const maxReminders = input.maxReminders ?? DEFAULT_CONFIG.maxReminders;
    if (!Number.isSafeInteger(reminderAfterCalls) || reminderAfterCalls < 0) {
        throw new Error('disclosure-policy: reminderAfterCalls must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(maxReminders) || maxReminders < 0) {
        throw new Error('disclosure-policy: maxReminders must be a non-negative safe integer');
    }
    return Object.freeze({ reminderAfterCalls, maxReminders });
}
/**
 * True when any visible `text` block carries a non-whitespace character.
 *
 * Reasoning blocks are not disclosure, and an empty or whitespace-only text
 * block is not a message the supervisor can read. Because this predicate is the
 * whole quality rule, a one-word acknowledgement resets the interval exactly
 * like a real disclosure; the runtime does not score semantics.
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
const OPEN_INTERVAL = Object.freeze({ calls: 0, firstReminderAt: null, delivered: 0 });
/** `turn/start` initializes the interval. */
export function createSilence() {
    return { ...OPEN_INTERVAL };
}
/**
 * Open a new interval in place: visible model text (or a new turn) clears the
 * call count, the first-reminder anchor, and the delivered count, without
 * replacing the record.
 */
export function resetSilence(state) {
    Object.assign(state, OPEN_INTERVAL);
    return state;
}
/**
 * Count one completed top-level call and report which reminder it carries.
 *
 * Nested calls inside a composite tool never count. The result is independent of
 * whether the call succeeded, failed, or was denied by another policy, because
 * every settled call reaches the caller exactly once.
 *
 * The cadence is per interval, not per call: `null` means this call carries no
 * reminder, and a number selects the text (see {@link reminderTextFor}).
 * `markReminderDelivered` is a separate step on purpose — a boundary that throws
 * or is otherwise unable to deliver context must not consume a budget slot.
 */
export function countCompletedCall(state, reminderAfterCalls, maxReminders, options = {}) {
    if (options.nested === true)
        return null;
    state.calls += 1;
    if (reminderAfterCalls <= 0 || maxReminders <= 0)
        return null;
    const index = state.delivered;
    if (index >= maxReminders)
        return null;
    // The first reminder lands at the threshold call and anchors the cadence; each
    // later one lands `reminderAfterCalls` calls after that anchor, which keeps
    // the cadence at one delivered reminder per period. A boundary that could not
    // deliver simply leaves the anchor unset, so the cadence starts at the next
    // boundary that can.
    const dueAt = state.firstReminderAt === null
        ? reminderAfterCalls
        : state.firstReminderAt + index * reminderAfterCalls;
    if (state.calls < dueAt)
        return null;
    return index;
}
/**
 * Record that a reminder was actually delivered at call count `calls`.
 *
 * Called only where `additionalContexts` can carry the notice, so an interval's
 * budget is spent by delivered reminders rather than attempted ones.
 */
export function markReminderDelivered(state, calls, index) {
    switch (state.firstReminderAt) {
        case null:
            state.firstReminderAt = calls;
            break;
        default:
            break;
    }
    state.delivered = index + 1;
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
    'You do not need an opening preamble. Ask the user a question only when the execution brief does not let you continue; otherwise keep working and disclose. Never expose private chain-of-thought.',
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
/**
 * The one sentence that distinguishes a later reminder in the same interval.
 *
 * It states the bounded runtime fact the plugin actually observed — this
 * interval is a repeat reminder and still carries no visible model text. That is
 * verifiable and is information the model does not reliably have about itself,
 * which is what a repeat buys. "Repeat" labels the message, not the model's
 * conduct, so it stays true without accusing anyone.
 *
 * It deliberately does not count reminders or mention a budget: telling the
 * model how many notices remain would let it wait the cadence out and turn the
 * disclosure policy into a game.
 */
export const DISCLOSURE_REPEAT_TEXT = 'This is a repeat reminder: no visible disclosure has been sent in this stretch.';
/**
 * The reminder text for one budget slot: the first reminder in an interval is
 * {@link DISCLOSURE_REMINDER_TEXT} verbatim, and every later one appends
 * {@link DISCLOSURE_REPEAT_TEXT} without changing the request.
 */
export function reminderTextFor(index, activityFact = null) {
    const parts = [DISCLOSURE_REMINDER_TEXT];
    if (activityFact !== null)
        parts.push(activityFact);
    if (index > 0)
        parts.push(DISCLOSURE_REPEAT_TEXT);
    return parts.join(' ');
}
