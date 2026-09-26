import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { classifyToolActivity, countCompletedCall, createActivity, createSilence, DEFAULT_CONFIG, DISCLOSURE_PLUGIN_NAME, DISCLOSURE_POLICY_ORDER, DISCLOSURE_POLICY_SECTION_NAME, DISCLOSURE_POLICY_TEXT, inspectionActivityFact, isModelDisclosure, markReminderDelivered, recordActivity, reminderTextFor, resetSilence, resolveConfig, withReminder, } from './policy.js';
export const name = DISCLOSURE_PLUGIN_NAME;
export const inject = ['tools'];
export const Config = z.object({
    reminderAfterCalls: z.number().step(1).min(0).default(DEFAULT_CONFIG.reminderAfterCalls),
    maxReminders: z.number().step(1).min(0).default(DEFAULT_CONFIG.maxReminders),
    activityWindowSize: z.number().step(1).min(0).default(DEFAULT_CONFIG.activityWindowSize),
    inspectionHintMinInspections: z.number().step(1).min(1).default(DEFAULT_CONFIG.inspectionHintMinInspections),
});
const SOURCE = {
    kind: 'disclosure-policy',
    form: 'notice',
    summary: 'Disclosure reminder',
};
const CONTINUE_AFTER_DISCLOSURE_TEXT = [
    '[disclosure] The previous structured disclosure was a progress checkpoint, not a terminal response.',
    'Continue the stated next action now if it is executable. If the task is complete or blocked, respond normally instead; do not emit another disclosure merely to satisfy this notice.',
].join(' ');
function notice(text) {
    return createUserMessage({
        content: [{ type: 'text', text }],
        source: SOURCE,
    });
}
/**
 * `dsh-disclosure-policy` host plugin.
 *
 * Three extension points:
 *
 * - `session/event` maintains one turn-local disclosure interval per session from
 *   first-party durable facts;
 * - `tools/post-execute` counts settled top-level calls and appends the due
 *   soft reminder as next-step context, at most `maxReminders` per interval;
 * - `agent/turn-stopping` repairs one narrow failure mode: after a delivered
 *   reminder, a standalone structured disclosure must not accidentally become
 *   the terminal response while executable work was meant to continue.
 *
 * The standing policy is a static prompt section. No guard is registered and no
 * task state is read or written. Stop-boundary steering is bounded to one extra
 * step per turn and only after a reminder-triggered standalone disclosure:
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
                intervals.set(session, {
                    silence: createSilence(),
                    activity: createActivity(config.activityWindowSize),
                    reminderOutstanding: false,
                    standaloneDisclosureAfterReminder: false,
                    continuationUsed: false,
                });
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
                    // A reminder-triggered disclosure that contains no tool call is the
                    // exact shape that can accidentally terminate a long autonomous turn.
                    // Remember only that narrow case for the turn-stopping boundary.
                    interval.standaloneDisclosureAfterReminder = interval.reminderOutstanding
                        && !event.data.message.content.some(block => block.type === 'tool-call');
                    interval.reminderOutstanding = false;
                    // Recent activity survives disclosure; only reminder accounting resets.
                    resetSilence(interval.silence);
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
        const activityFact = inspectionActivityFact(interval.activity, config.inspectionHintMinInspections);
        markReminderDelivered(interval.silence, interval.silence.calls, index);
        interval.reminderOutstanding = true;
        return withReminder(downstream, notice(reminderTextFor(index, activityFact)));
    });
    // A standalone disclosure can satisfy the reminder yet also make the model
    // return `stop`, which would otherwise close the turn before its stated Next
    // action runs. Repair only that reminder-caused shape, and only once per turn.
    // The continuation notice explicitly allows normal completion or blocking, so
    // it does not require invented work and cannot create an unbounded loop.
    ctx.on('agent/turn-stopping', ({ agent }) => {
        const interval = intervals.get(agent.session);
        if (interval === undefined
            || !interval.standaloneDisclosureAfterReminder
            || interval.continuationUsed)
            return;
        interval.continuationUsed = true;
        interval.standaloneDisclosureAfterReminder = false;
        agent.steer(notice(CONTINUE_AFTER_DISCLOSURE_TEXT));
    });
}
