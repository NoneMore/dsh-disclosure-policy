/**
 * Pure disclosure policy.
 *
 * This module deliberately imports nothing from the host so the complete
 * behavior — disclosure accounting, reminder cadence, budget, and post-execute
 * composition — can be unit-tested without the DeepSeek Harness dependency
 * graph. `index.ts` is only the adapter that binds these decisions to Cordis
 * extension points.
 */
/** Package/plugin identity carried by every notice this policy emits. */
export declare const DISCLOSURE_PLUGIN_NAME = "disclosure-policy";
/**
 * Static system-prompt order for the standing disclosure policy: after the
 * first-party Web-surface guidance (`WEB_SURFACE = 10100`) and before the
 * deployment persona suffix (`DEPLOYMENT_PERSONA_SUFFIX = 10200`).
 */
export declare const DISCLOSURE_POLICY_ORDER = 10150;
/** Prompt-section name; unique within its layer. */
export declare const DISCLOSURE_POLICY_SECTION_NAME = "plugin:disclosure-policy:policy";
export interface DisclosureConfig {
    /**
     * Completed top-level tool calls that advance the reminder cadence by one
     * position. `0` disables runtime reminders while keeping the standing policy.
     */
    reminderAfterCalls: number;
    /**
     * Reminder budget for one disclosure interval: at most this many notices, one
     * every `reminderAfterCalls` completed top-level calls, after which the
     * interval gets no more reminders until structured disclosure opens a new one. `1` is the
     * historical one-shot cadence; `0` disables runtime reminders.
     */
    maxReminders: number;
    /** Recent observed operations retained for activity hints; 0 disables hints alone. */
    activityWindowSize: number;
    /** Minimum inspections in the activity window, independent of reminder cadence. */
    inspectionHintMinInspections: number;
}
export declare const DEFAULT_CONFIG: Readonly<DisclosureConfig>;
export type ActivityKind = 'inspect' | 'mutate' | 'verify' | 'other';
export interface ActivityState {
    inspect: number;
    mutate: number;
    verify: number;
    other: number;
    readonly windowSize: number;
    readonly operations: ActivityKind[];
    next: number;
}
/** Bounded activity window, independent of disclosure intervals. */
export declare function createActivity(windowSize?: number): ActivityState;
/** Explicitly clear the activity window; disclosure does not call this helper. */
export declare function resetActivity(state: ActivityState): ActivityState;
/**
 * Classify one tool by its structured name only.
 *
 * This intentionally stays conservative: generic shells and composite transports
 * are `other`; their nested native tools can still contribute their own activity.
 */
export declare function classifyToolActivity(toolName: string): ActivityKind;
/** Observe one operation, evicting the oldest when the window is full. */
export declare function recordActivity(state: ActivityState, kind: ActivityKind): ActivityState;
/**
 * Objective context for an inspection-only stretch, or `null` when the shape
 * is not notable enough to add to the normal disclosure reminder.
 *
 * The fact does not say the work is excessive or unproductive. It only reports
 * the observed tool mix and asks the model to name the unresolved fact that
 * justifies more investigation.
 */
export declare function inspectionActivityFact(state: ActivityState, minimumInspections: number): string | null;
/**
 * Resolve and validate behavioral options. The schema in `index.ts`
 * already rejects malformed DSH config rows; this second check keeps the pure
 * module authoritative and fails closed for direct callers.
 */
export declare function resolveConfig(input?: Partial<DisclosureConfig>): DisclosureConfig;
export interface ContentBlockLike {
    readonly type: string;
    readonly text?: unknown;
}
export interface MessageLike {
    readonly role?: string;
    readonly source?: {
        readonly kind?: string;
    };
    readonly content: readonly ContentBlockLike[];
}
/**
 * True when any visible `text` block carries a non-whitespace character.
 *
 * Reasoning blocks and whitespace-only text are not visible speech. Visibility
 * alone does not establish disclosure; see isModelDisclosure().
 */
export declare function hasVisibleText(content: readonly ContentBlockLike[]): boolean;
/**
 * True when committed model-authored visible text has the agreed disclosure
 * structure. Recognition verifies expression only, never content quality.
 */
export declare function isModelDisclosure(message: MessageLike): boolean;
/**
 * One turn-local disclosure interval: completed top-level tool calls since the
 * last recognized structured disclosure. The exported name is retained for
 * compatibility with existing policy callers.
 *
 * The reminder budget belongs to this interval, so the interval — not the
 * individual reminder — is the unit that resets with structured disclosure.
 */
export interface SilenceState {
    /** Completed top-level tool calls since the interval opened. Never reset by a reminder. */
    calls: number;
    /** Call count where this interval's first reminder was actually delivered; `null` means none yet. */
    firstReminderAt: number | null;
    /** Reminders delivered in this interval, and the budget index of the next one. */
    delivered: number;
}
/** `turn/start` initializes the interval. */
export declare function createSilence(): SilenceState;
/**
 * Open a new interval in place: recognized disclosure (or a new turn) clears the
 * call count, the first-reminder anchor, and the delivered count, without
 * replacing the record.
 */
export declare function resetSilence(state: SilenceState): SilenceState;
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
export declare function countCompletedCall(state: SilenceState, reminderAfterCalls: number, maxReminders: number, options?: {
    readonly nested?: boolean;
}): number | null;
/**
 * Record that a reminder was actually delivered at call count `calls`.
 *
 * Called only where `additionalContexts` can carry the notice, so an interval's
 * budget is spent by delivered reminders rather than attempted ones.
 */
export declare function markReminderDelivered(state: SilenceState, calls: number, index: number): void;
export interface ReminderCarrier<TNotice> {
    readonly kind: string;
    readonly additionalContexts?: readonly TNotice[];
}
/**
 * Compose one reminder into a downstream `tools/post-execute` decision.
 *
 * The decision is preserved rather than replaced: its kind and every other
 * field survive, our notice goes first, and contexts the downstream listener
 * supplied stay after ours.
 */
export declare function withReminder<TNotice, TDecision extends ReminderCarrier<TNotice>>(decision: TDecision, reminder: TNotice): TDecision;
/**
 * The standing policy installed at {@link DISCLOSURE_POLICY_ORDER}.
 *
 * It states the semantic obligation — when disclosure is worth sending and what
 * it should answer — and nothing else. It carries no runtime state, no cadence,
 * and no enforcement.
 */
export declare const DISCLOSURE_POLICY_TEXT: string;
/**
 * The one soft reminder, delivered as next-step context through
 * `tools/post-execute`.
 *
 * It asks for the same short structure as the standing policy. The base text
 * is purely instructional; a caller may compose one
 * objective activity fact beside it. Neither path threatens denial, requests
 * user input, or asks for chain-of-thought.
 */
export declare const DISCLOSURE_REMINDER_TEXT: string;
/**
 * The one sentence that distinguishes a later reminder in the same interval.
 *
 * It states the bounded runtime fact the plugin actually observed — this
 * interval is a repeat reminder and still carries no structured disclosure. That is
 * verifiable and is information the model does not reliably have about itself,
 * which is what a repeat buys. "Repeat" labels the message, not the model's
 * conduct, so it stays true without accusing anyone.
 *
 * It deliberately does not count reminders or mention a budget: telling the
 * model how many notices remain would let it wait the cadence out and turn the
 * disclosure policy into a game.
 */
export declare const DISCLOSURE_REPEAT_TEXT = "This is a repeat reminder: no complete structured disclosure has been observed in this stretch.";
/**
 * The reminder text for one budget slot: the first reminder in an interval is
 * {@link DISCLOSURE_REMINDER_TEXT} verbatim, and every later one appends
 * {@link DISCLOSURE_REPEAT_TEXT} without changing the request.
 */
export declare function reminderTextFor(index: number, activityFact?: string | null): string;
