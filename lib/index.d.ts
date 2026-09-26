import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type ContextFormed } from '@deepseek-ai/dsh-llm';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'disclosure-policy': {
            kind: 'disclosure-policy';
        } & ContextFormed;
    }
}
export declare const name = "disclosure-policy";
export declare const inject: string[];
export interface Config {
    /**
     * Completed top-level tool calls that advance the reminder cadence by one
     * position. `0` disables runtime reminders while leaving the disclosure tool
     * available. Default 8.
     */
    reminderAfterCalls?: number;
    /**
     * Reminder budget for one disclosure interval: at most this many notices, one
     * every `reminderAfterCalls` completed top-level calls. `1` restores a
     * one-shot reminder; `0` disables runtime reminders. Default 3.
     */
    maxReminders?: number;
    /** Recent operations retained, including nested native tools; 0 disables hints alone. Default 16. */
    activityWindowSize?: number;
    /** Minimum inspections in the activity window, independent of cadence. Default 8. */
    inspectionHintMinInspections?: number;
}
export declare const Config: z<Config>;
/**
 * `dsh-disclosure-policy` host plugin.
 *
 * Disclosure is a first-class model action rather than a magic Assistant-text
 * shape. The registered `disclose_progress` tool carries the standing policy in
 * its compact schema description, records model-authored progress as durable tool
 * arguments, and opens a fresh reminder interval when it executes.
 *
 * Runtime accounting still uses only two lightweight observation points:
 *
 * - `session/event` creates/discards one turn-local interval;
 * - `tools/post-execute` counts settled work and appends bounded reminder
 *   context when the model has gone too long without calling `disclose_progress`.
 *
 * No guard, TODO mutation, semantic prose classifier, or turn-stop steering is
 * registered. See ADR-0007.
 */
export declare function apply(ctx: Context, rawConfig?: Config): void;
