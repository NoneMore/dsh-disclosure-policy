/**
 * Pure disclosure policy.
 *
 * Runtime disclosure is now a structured tool action rather than an Assistant
 * text shape. This module keeps reminder/activity accounting host-independent.
 */
/** Package/plugin identity carried by reminder notices. */
export declare const DISCLOSURE_PLUGIN_NAME = "disclosure-policy";
/** Structured progress primitive registered by the host adapter. */
export declare const DISCLOSURE_TOOL_NAME = "disclose_progress";
/**
 * Kept for policy-API compatibility. The plugin no longer mounts a separate
 * standing prompt section; the compact tool declaration carries this policy.
 */
export declare const DISCLOSURE_POLICY_ORDER = 10150;
export declare const DISCLOSURE_POLICY_SECTION_NAME = "plugin:disclosure-policy:policy";
export declare const DISCLOSURE_POLICY_TEXT = "During long autonomous work, use disclose_progress for brief supervisor checkpoints and continue unless blocked.";
/**
 * Keep this compact: tool declarations are fixed per-request context in native
 * mode and become generated SDK text in PTC mode.
 */
export declare const DISCLOSURE_TOOL_DESCRIPTION = "Checkpoint long autonomous work: report done, next, and approach; then continue unless blocked.";
export interface DisclosureConfig {
    /** Completed top-level non-disclosure calls per reminder period; 0 disables reminders. */
    reminderAfterCalls: number;
    /** Reminder budget for one disclosure interval; 0 disables reminders. */
    maxReminders: number;
    /** Recent operations retained for activity hints; 0 disables hints alone. */
    activityWindowSize: number;
    /** Minimum inspections in the activity window, independent of cadence. */
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
export declare function createActivity(windowSize?: number): ActivityState;
export declare function resetActivity(state: ActivityState): ActivityState;
export declare function classifyToolActivity(toolName: string): ActivityKind;
export declare function recordActivity(state: ActivityState, kind: ActivityKind): ActivityState;
/** Compact factual suffix used only when the normal reminder is already due. */
export declare function inspectionActivityFact(state: ActivityState, minimumInspections: number): string | null;
export declare function resolveConfig(input?: Partial<DisclosureConfig>): DisclosureConfig;
/**
 * Legacy expression helpers retained for ./policy API compatibility.
 * Runtime accounting no longer inspects Assistant prose.
 */
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
/** @deprecated Runtime disclosure uses disclose_progress instead. */
export declare function hasVisibleText(content: readonly ContentBlockLike[]): boolean;
/** @deprecated Runtime disclosure uses disclose_progress instead. */
export declare function isModelDisclosure(message: MessageLike): boolean;
export interface SilenceState {
    calls: number;
    firstReminderAt: number | null;
    delivered: number;
}
export declare function createSilence(): SilenceState;
export declare function resetSilence(state: SilenceState): SilenceState;
export declare function countCompletedCall(state: SilenceState, reminderAfterCalls: number, maxReminders: number, options?: {
    readonly nested?: boolean;
}): number | null;
export declare function markReminderDelivered(state: SilenceState, calls: number, index: number): void;
export interface ReminderCarrier<TNotice> {
    readonly kind: string;
    readonly additionalContexts?: readonly TNotice[];
}
export declare function withReminder<TNotice, TDecision extends ReminderCarrier<TNotice>>(decision: TDecision, reminder: TNotice): TDecision;
export declare const DISCLOSURE_REMINDER_TEXT = "[disclosure] Call disclose_progress with a brief done/next/approach checkpoint, then continue unless blocked.";
export declare const DISCLOSURE_REPEAT_TEXT = "Repeat reminder: no disclose_progress call has been observed in this interval.";
export declare function reminderTextFor(index: number, activityFact?: string | null): string;
