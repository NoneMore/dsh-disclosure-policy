/**
 * Pure disclosure policy.
 *
 * The host adapter owns tool registration. This module contains only lightweight
 * accounting, activity classification, and reminder composition so it stays
 * testable without the DeepSeek Harness dependency graph.
 */
/** Package/plugin identity carried by every notice this policy emits. */
export declare const DISCLOSURE_PLUGIN_NAME = "disclosure-policy";
/** Model-facing progress action registered by the host adapter. */
export declare const DISCLOSURE_TOOL_NAME = "disclose_progress";
/**
 * The tool schema is the standing model-facing contract. Keep this short because
 * it is present in every request that exposes the tool.
 */
export declare const DISCLOSURE_TOOL_DESCRIPTION = "Brief update after findings, phase/plan shifts, checks, blockers, or long work: done, next, approach; batch with work.";
/**
 * Historical prompt exports remain for policy-API compatibility. The host plugin
 * no longer mounts this section, so they add zero model-context cost.
 */
export declare const DISCLOSURE_POLICY_ORDER = 10150;
export declare const DISCLOSURE_POLICY_SECTION_NAME = "plugin:disclosure-policy:policy";
export declare const DISCLOSURE_POLICY_TEXT = "Brief update after findings, phase/plan shifts, checks, blockers, or long work: done, next, approach; batch with work.";
export interface DisclosureConfig {
    /**
     * Completed top-level work calls that advance the reminder cadence by one
     * position. `0` disables runtime reminders while keeping the disclosure tool.
     */
    reminderAfterCalls: number;
    /**
     * Reminder budget for one disclosure interval. `1` is a one-shot reminder;
     * `0` disables reminders.
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
/** Classify one tool by its structured name only. */
export declare function classifyToolActivity(toolName: string): ActivityKind;
/** Observe one operation, evicting the oldest when the window is full. */
export declare function recordActivity(state: ActivityState, kind: ActivityKind): ActivityState;
/**
 * Objective context for an inspection-only stretch, or `null` when the shape
 * is not notable enough to add to the ordinary reminder.
 */
export declare function inspectionActivityFact(state: ActivityState, minimumInspections: number): string | null;
/** Resolve and validate behavioral options. */
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
 * Legacy visibility helpers retained for API compatibility. Runtime disclosure
 * accounting no longer uses Assistant prose recognition.
 */
export declare function hasVisibleText(content: readonly ContentBlockLike[]): boolean;
/** @deprecated Runtime disclosure is now the `disclose_progress` tool action. */
export declare function isModelDisclosure(message: MessageLike): boolean;
/**
 * One turn-local disclosure interval: completed top-level work calls since the
 * latest successful `disclose_progress` execution.
 */
export interface SilenceState {
    /** Completed top-level work calls since the interval opened. */
    calls: number;
    /** Call count where this interval's first reminder was actually delivered. */
    firstReminderAt: number | null;
    /** Reminders delivered in this interval, and the budget index of the next one. */
    delivered: number;
}
export declare function createSilence(): SilenceState;
/** Open a new reminder interval in place. */
export declare function resetSilence(state: SilenceState): SilenceState;
/**
 * Count one completed top-level work call and report which reminder it carries.
 * Nested calls inside a composite tool do not advance cadence.
 */
export declare function countCompletedCall(state: SilenceState, reminderAfterCalls: number, maxReminders: number, options?: {
    readonly nested?: boolean;
}): number | null;
/** Record that a reminder was actually delivered. */
export declare function markReminderDelivered(state: SilenceState, calls: number, index: number): void;
export interface ReminderCarrier<TNotice> {
    readonly kind: string;
    readonly additionalContexts?: readonly TNotice[];
}
/** Prepend one reminder without replacing any downstream decision fields. */
export declare function withReminder<TNotice, TDecision extends ReminderCarrier<TNotice>>(decision: TDecision, reminder: TNotice): TDecision;
/**
 * Runtime reminder text is intentionally tiny. The standing behavioral contract
 * lives in the `disclose_progress` tool schema, which the model already receives,
 * so repeating field-format instructions here would spend tokens twice.
 */
export declare const DISCLOSURE_REMINDER_TEXT = "[disclosure] Call disclose_progress now with a brief checkpoint; if work remains, batch it with the next work tool(s).";
export declare const DISCLOSURE_REPEAT_TEXT = "Repeat reminder: no disclose_progress call has been observed in this stretch.";
export declare function reminderTextFor(index: number, activityFact?: string | null): string;
