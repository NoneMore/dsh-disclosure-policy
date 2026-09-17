import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { countCompletedCall, createSilence, DEFAULT_CONFIG, DISCLOSURE_PLUGIN_NAME, DISCLOSURE_POLICY_ORDER, DISCLOSURE_POLICY_SECTION_NAME, DISCLOSURE_POLICY_TEXT, isModelDisclosure, markReminderDelivered, reminderTextFor, resetSilence, resolveConfig, withReminder, } from './policy.js';
export const name = DISCLOSURE_PLUGIN_NAME;
export const inject = ['tools'];
export const Config = z.object({
    reminderAfterCalls: z.number().step(1).min(0).default(DEFAULT_CONFIG.reminderAfterCalls),
    maxReminders: z.number().step(1).min(0).default(DEFAULT_CONFIG.maxReminders),
});
const SOURCE = {
    kind: 'plugin',
    plugin: DISCLOSURE_PLUGIN_NAME,
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
export function apply(ctx, rawConfig = {}) {
    const config = resolveConfig(rawConfig);
    const silences = new WeakMap();
    ctx.on('session/event', (session, event) => {
        switch (event.type) {
            case 'turn/start':
                silences.set(session, createSilence());
                return;
            case 'turn/end':
                silences.delete(session);
                return;
            case 'assistant/message': {
                const state = silences.get(session);
                if (state === undefined)
                    return;
                // Model-authored visible text opens a new interval. Reasoning blocks
                // and plugin-authored messages are not disclosure and never reset it.
                if (isModelDisclosure(event.data.message))
                    resetSilence(state);
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
        let downstream;
        try {
            downstream = await next();
        }
        catch (error) {
            const state = exec.agent === undefined ? undefined : silences.get(exec.agent.session);
            if (state !== undefined) {
                // This boundary has no decision to carry additional context, so the
                // call still advances the cadence but cannot spend a budget slot.
                countCompletedCall(state, config.reminderAfterCalls, config.maxReminders, {
                    nested: exec.parent !== undefined,
                });
            }
            throw error;
        }
        const state = exec.agent === undefined ? undefined : silences.get(exec.agent.session);
        if (state === undefined)
            return downstream;
        const index = countCompletedCall(state, config.reminderAfterCalls, config.maxReminders, {
            nested: exec.parent !== undefined,
        });
        if (index === null)
            return downstream;
        markReminderDelivered(state, state.calls, index);
        return withReminder(downstream, notice(reminderTextFor(index)));
    });
}
