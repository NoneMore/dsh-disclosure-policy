import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "disclosure-policy";
export declare const inject: string[];
export interface Config {
    /**
     * Completed top-level tool calls that advance the reminder cadence by one
     * position. `0` disables runtime reminders while keeping the standing policy.
     * Default 8.
     */
    reminderAfterCalls?: number;
    /**
     * Reminder budget for one silence interval: at most this many notices, one
     * every `reminderAfterCalls` completed top-level calls. `1` is the historical
     * one-shot cadence; `0` disables runtime reminders. Default 3.
     */
    maxReminders?: number;
}
export declare const Config: z<Config>;
/**
 * `dsh-disclosure-policy` host plugin.
 *
 * Two extension points only:
 *
 * - `session/event` maintains one turn-local silence interval per session from
 *   first-party durable facts;
 * - `tools/post-execute` counts settled top-level calls and appends the due
 *   soft reminder as next-step context, at most `maxReminders` per interval.
 *
 * The standing policy is a static prompt section. No guard is registered, no
 * task state is read or written, and nothing is steered from an event callback:
 * see ADR-0001 and ADR-0003. The runtime keeps live projections instead of
 * scanning session history, which current DSH policy requires for new code; a
 * hot reload mid-turn therefore starts accounting at the next `turn/start`.
 */
export declare function apply(ctx: Context, rawConfig?: Config): void;
