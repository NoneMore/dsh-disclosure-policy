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
    /** Completed top-level non-disclosure calls per reminder period. 0 disables reminders. Default 8. */
    reminderAfterCalls?: number;
    /** Reminder budget per disclosure interval. 0 disables reminders. Default 3. */
    maxReminders?: number;
    /** Recent operations retained, including nested native tools; 0 disables hints alone. Default 16. */
    activityWindowSize?: number;
    /** Minimum inspections in the activity window, independent of cadence. Default 8. */
    inspectionHintMinInspections?: number;
}
export declare const Config: z<Config>;
/**
 * Host adapter.
 *
 * Disclosure is a model-authored structured tool action rather than Assistant
 * prose. That removes the ambiguity between "progress update" and "terminal
 * response": a successful disclose_progress call resets the interval and the
 * agent naturally continues through the normal tool loop.
 *
 * Context cost stays bounded: no standing prompt section is installed, the tool
 * declaration is intentionally compact, its successful result renders no model
 * text, and reminders contain no format template.
 */
export declare function apply(ctx: Context, rawConfig?: Config): void;
