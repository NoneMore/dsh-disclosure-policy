import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, RUN_CODE_NAME, type PostToolDecision } from '@deepseek-ai/dsh-tools'
import {
  classifyToolActivity,
  countCompletedCall,
  createActivity,
  createSilence,
  DEFAULT_CONFIG,
  DISCLOSURE_PLUGIN_NAME,
  DISCLOSURE_TOOL_DESCRIPTION,
  DISCLOSURE_TOOL_NAME,
  inspectionActivityFact,
  markReminderDelivered,
  recordActivity,
  reminderTextFor,
  resetSilence,
  resolveConfig,
  withReminder,
  type ActivityState,
  type SilenceState,
} from './policy.js'

// Declaration-merging side effects keep current DSH event/service names typed.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'disclosure-policy': { kind: 'disclosure-policy' } & ContextFormed
  }
}

export const name = DISCLOSURE_PLUGIN_NAME
export const inject = ['tools', 'agents']

export interface Config {
  /**
   * Completed top-level tool calls that advance the reminder cadence by one
   * position. `0` disables runtime reminders while leaving the disclosure tool
   * available. Default 8.
   */
  reminderAfterCalls?: number
  /**
   * Reminder budget for one disclosure interval: at most this many notices, one
   * every `reminderAfterCalls` completed top-level calls. `1` restores a
   * one-shot reminder; `0` disables runtime reminders. Default 3.
   */
  maxReminders?: number
  /** Recent operations retained for an eligible native root; 0 disables hints alone. Default 16. */
  activityWindowSize?: number
  /** Minimum inspections in the activity window, independent of cadence. Default 8. */
  inspectionHintMinInspections?: number
}

export const Config: z<Config> = z.object({
  reminderAfterCalls: z.number().step(1).min(0).default(DEFAULT_CONFIG.reminderAfterCalls),
  maxReminders: z.number().step(1).min(0).default(DEFAULT_CONFIG.maxReminders),
  activityWindowSize: z.number().step(1).min(0).default(DEFAULT_CONFIG.activityWindowSize),
  inspectionHintMinInspections: z.number().step(1).min(1).default(DEFAULT_CONFIG.inspectionHintMinInspections),
})

interface IntervalState {
  silence: SilenceState
  activity: ActivityState
  step: number | null
  stepTopLevelCalls: number
  pendingDisclosureStep: number | null
  remindedStep: number | null
}

const SOURCE = {
  kind: 'disclosure-policy' as const,
  form: 'notice' as const,
  summary: 'Progress checkpoint reminder',
}

function notice(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text' as const, text }],
    source: SOURCE,
  })
}

/**
 * Install disclosure policy into one eligible Agent scope.
 *
 * Agent-scoped registration is important here: the progress tool and both
 * runtime listeners should not exist for PTC/both presentation or runtime
 * child agents.
 */
function installForAgent(
  agentCtx: Context,
  agent: Agent,
  config: ReturnType<typeof resolveConfig>,
): void {
  let interval: IntervalState | undefined

  agentCtx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    switch (event.type) {
      case 'turn/start':
        interval = {
          silence: createSilence(),
          activity: createActivity(config.activityWindowSize),
          step: null,
          stepTopLevelCalls: 0,
          pendingDisclosureStep: null,
          remindedStep: null,
        }
        return
      case 'assistant/message': {
        if (interval === undefined) return
        interval.step = event.data.step
        interval.stepTopLevelCalls = 0
        interval.remindedStep = interval.remindedStep === event.data.step ? interval.remindedStep : null
        interval.pendingDisclosureStep = event.data.message.content.some(block =>
          block.type === 'tool-call' && block.name === DISCLOSURE_TOOL_NAME)
          ? event.data.step
          : null
        return
      }
      case 'turn/end':
        interval = undefined
        return
      default:
        return
    }
  })

  agentCtx.tools.register(defineTool({
    name: DISCLOSURE_TOOL_NAME,
    description: DISCLOSURE_TOOL_DESCRIPTION,
    parameters: {
      done: { type: 'string', required: true },
      next: { type: 'string', required: true },
      approach: { type: 'string', required: true },
    },
    // DSH is fail-closed here: omission means exclusive. This no-I/O checkpoint
    // is safe to overlap with sibling work and must not create a scheduling barrier.
    isConcurrencySafe: () => true,
    output: {
      schema: { type: 'null' },
      // The call arguments are the human-facing disclosure. Echoing them in the
      // result would duplicate context, so successful disclosure has no result text.
      render: () => [],
    },
    async execute(args, exec) {
      if (args.done.trim() === '' || args.next.trim() === '' || args.approach.trim() === '') {
        throw new Error('disclose_progress: done, next, and approach must be non-empty')
      }
      if (exec.agent === agent && interval !== undefined) {
        resetSilence(interval.silence)
        // A checkpoint resets the previous interval, but top-level sibling work
        // already completed in this Assistant step must not disappear with it.
        // Carry that work into the fresh interval; later siblings naturally keep
        // advancing the same counter regardless of parallel settlement order.
        interval.silence.calls = interval.stepTopLevelCalls
        interval.pendingDisclosureStep = interval.step
      }
      return null
    },
  }))

  // Soft reminders compose with downstream post-execute policy and never deny a
  // call. The disclosure tool itself is accounting-neutral: executing it already
  // opened a new interval, and treating it as work would immediately consume one
  // call of that fresh interval.
  agentCtx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    if (exec.agent !== agent) return next()
    if (exec.name === DISCLOSURE_TOOL_NAME) return next()

    const current = interval
    const observe = (): number | null => {
      if (current === undefined) return null
      recordActivity(current.activity, classifyToolActivity(exec.name))
      const nested = exec.parent !== undefined
      if (!nested) current.stepTopLevelCalls += 1
      return countCompletedCall(current.silence, config.reminderAfterCalls, config.maxReminders, {
        nested,
      })
    }

    let downstream: PostToolDecision
    try {
      downstream = await next()
    } catch (error) {
      observe()
      throw error
    }

    if (current === undefined) return downstream
    const index = observe()
    if (index === null) return downstream

    const step = current.step
    // If this step is already trying to disclose, do not race it with a stale
    // reminder. Likewise, one model step can carry at most one reminder even if a
    // large parallel fan-out crosses several cadence periods.
    if (
      step !== null
      && (current.pendingDisclosureStep === step || current.remindedStep === step)
    ) return downstream

    const activityFact = inspectionActivityFact(current.activity, config.inspectionHintMinInspections)
    markReminderDelivered(current.silence, current.silence.calls, index)
    current.remindedStep = step
    return withReminder(downstream, notice(reminderTextFor(index, activityFact)))
  })
}

/** Whether this live agent should receive the disclosure surface. */
function isEligibleAgent(ctx: Context, agent: Agent): boolean {
  if (!ctx.agents.roots().includes(agent)) return false
  const { origin, delegationDepth } = agent.session.header
  if (origin === 'subagent' || (delegationDepth ?? 0) > 0) return false
  // ToolRuntime inserts reserved run_code into the effective view for both
  // `ptc` and `both`, but not for exact `native` presentation.
  return agent.ctx.tools.get(RUN_CODE_NAME, agent) === undefined
}

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
export function apply(ctx: Context, rawConfig: Config = {}): void {
  const config = resolveConfig(rawConfig)
  const installed = new WeakSet<Agent>()

  const install = (agent: Agent): void => {
    if (installed.has(agent) || !isEligibleAgent(ctx, agent)) return
    installForAgent(agent.ctx, agent, config)
    installed.add(agent)
  }

  // Hot reload may mount after a root already exists; normal startup reaches
  // the same path through agent/created before the first queued input is released.
  for (const agent of ctx.agents.roots()) install(agent)

  ctx.on('agent/created', ({ agent }) => {
    install(agent)
  })
}
