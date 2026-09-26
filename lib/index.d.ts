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
    /** Recent operations retained for an eligible native root; 0 disables hints alone. Default 16. */
    activityWindowSize?: number;
    /** Minimum inspections in the activity window, independent of cadence. Default 8. */
    inspectionHintMinInspections?: number;
}
export declare const Config: z<Config>;
/**
 * `dsh-disclosure-policy` host plugin.
 *
 * The plugin is intentionally native-root-only. PTC/both agents and runtime
 * child agents receive no `disclose_progress` schema, no cadence state, and no
 * post-execute reminder listener.
 *
 * One global `agent/created` listener discovers future eligible roots. Each
 * eligible Agent owns the actual tool and observation listeners through
 * `agent.ctx`, so they unwind with that Agent and scope-filter naturally.
 *
 * No guard, TODO mutation, semantic prose classifier, or turn-stop steering is
 * registered. See ADR-0008.
 */
export declare function apply(ctx: Context, rawConfig?: Config): void;
