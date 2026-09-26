import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { classifyToolActivity, countCompletedCall, createActivity, createSilence, DEFAULT_CONFIG, DISCLOSURE_PLUGIN_NAME, DISCLOSURE_POLICY_ORDER, DISCLOSURE_POLICY_SECTION_NAME, DISCLOSURE_POLICY_TEXT, inspectionActivityFact, isModelDisclosure, markReminderDelivered, recordActivity, reminderTextFor, resetActivity, resetSilence, resolveConfig, withReminder, } from './policy.js';
export const name = DISCLOSURE_PLUGIN_NAME;
export const inject = ['tools'];
export const Config = z.object({
    reminderAfterCalls: z.number().step(1).min(0).default(DEFAULT_CONFIG.reminderAfterCalls),
    maxReminders: z.number().step(1).min(0).default(DEFAULT_CONFIG.maxReminders),
});
const SOURCE = {
    kind: 'disclosure-policy',
    form: 'notice',
    summary: 'Disclosure reminder',
};
function notice(text) {
    return createUserMessage({
        content: [{ type: 'text', text }],
        source: SOURCE,
    });
}
/**
 * `dsh-disclosure-policy` host plugin.
 *
 * Two extension points only:
 *
 * - `session/event` maintains one turn-local disclosure interval per session from
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
export function apply(ctx, rawConfig = {}) {
    const config = resolveConfig(rawConfig);
    const intervals = new WeakMap();
    ctx.on('session/event', (session, event) => {
        switch (event.type) {
            case 'turn/start':
                intervals.set(session, { silence: createSilence(), activity: createActivity() });
                return;
            case 'turn/end':
                intervals.delete(session);
                return;
            case 'assistant/message': {
                const interval = intervals.get(session);
                if (interval === undefined)
                    return;
                // Only complete structured model disclosure opens a new interval.
                // Ordinary prose, reasoning, and plugin context never reset it.
                if (isModelDisclosure(event.data.message)) {
                    resetSilence(interval.silence);
                    resetActivity(interval.activity);
                }
                return;
            }
            default:
                return;
        }
    });
    // The prompt service is optional by design: `inject` is for hard
    // requirements, so the capability is probed with ctx.get(). A deployment that
    // installs a complete replacement prompt may suppress this section; the
    // reminder keeps working.
    const systemPrompt = ctx.get('systemPrompt');
    if (systemPrompt !== undefined) {
        ctx.effect(() => systemPrompt.section({
            name: DISCLOSURE_POLICY_SECTION_NAME,
            order: DISCLOSURE_POLICY_ORDER,
            text: DISCLOSURE_POLICY_TEXT,
        }));
    }
    // The soft reminders. They compose with downstream post-execute policy
    // (accept or block) rather than replacing it, and they never deny a call.
    ctx.on('tools/post-execute', async (exec, _result, next) => {
        const interval = exec.agent === undefined ? undefined : intervals.get(exec.agent.session);
        const observe = () => {
            if (interval === undefined)
                return null;
            // Activity describes completed tool operations, including nested native
            // dispatches. Disclosure cadence still counts top-level calls only.
            recordActivity(interval.activity, classifyToolActivity(exec.name));
            return countCompletedCall(interval.silence, config.reminderAfterCalls, config.maxReminders, {
                nested: exec.parent !== undefined,
            });
        };
        let downstream;
        try {
            downstream = await next();
        }
        catch (error) {
            // This boundary has no decision to carry additional context, so the call
            // still advances both projections but cannot spend a reminder budget slot.
            observe();
            throw error;
        }
        if (interval === undefined)
            return downstream;
        const index = observe();
        if (index === null)
            return downstream;
        const activityFact = inspectionActivityFact(interval.activity, config.reminderAfterCalls);
        markReminderDelivered(interval.silence, interval.silence.calls, index);
        return withReminder(downstream, notice(reminderTextFor(index, activityFact)));
    });
}
