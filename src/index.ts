import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool, type PostToolDecision } from '@deepseek-ai/dsh-tools'
import {
  classifyToolActivity,
  countCompletedCall,
  createActivity,
  createSilence,
  DEFAULT_CONFIG,
  DISCLOSURE_PLUGIN_NAME,
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
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'disclosure-policy': { kind: 'disclosure-policy' } & ContextFormed
  }
}

export const name = DISCLOSURE_PLUGIN_NAME
export const inject = ['tools']

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
  /** Recent operations retained, including nested native tools; 0 disables hints alone. Default 16. */
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
}

const SOURCE = {
  kind: 'disclosure-policy' as const,
  form: 'notice' as const,
  summary: 'Disclosure reminder',
}

function notice(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text' as const, text }],
    source: SOURCE,
  })
}

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
export function apply(ctx: Context, rawConfig: Config = {}): void {
  const config = resolveConfig(rawConfig)
  const intervals = new WeakMap<Session, IntervalState>()

  ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'turn/start':
        intervals.set(session, { silence: createSilence(), activity: createActivity(config.activityWindowSize) })
        return
      case 'turn/end':
        intervals.delete(session)
        return
      default:
        return
    }
  })

  ctx.tools.register(defineTool({
    name: DISCLOSURE_TOOL_NAME,
    description: 'Report a brief non-terminal progress checkpoint to the supervisor. Use for material findings, phase completion, plan/constraint changes, verification, blockers, or when reminded; continue work afterward when possible.',
    parameters: {
      done: {
        type: 'string',
        required: true,
        description: 'Recent work and its result or remaining uncertainty.',
      },
      next: {
        type: 'string',
        required: true,
        description: 'Immediate intended action.',
      },
      approach: {
        type: 'string',
        required: true,
        description: 'Concrete operations or verification.',
      },
    },
    output: {
      schema: { type: 'null' },
      // Keep native model-facing result overhead to one tiny token. In PTC mode
      // nested canonical values remain execution-local while the durable sub-call
      // still exposes the model-authored arguments to the supervisor.
      render: () => [{ type: 'text' as const, text: 'ok' }],
    },
    // A disclosure is an ordering boundary: if the same model response also
    // requests more tools, run this checkpoint alone in submission order before
    // later work rather than racing it with the work it is describing.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (args.done.trim() === '' || args.next.trim() === '' || args.approach.trim() === '') {
        throw new Error('disclose_progress fields must be non-empty')
      }
      const interval = exec.agent === undefined ? undefined : intervals.get(exec.agent.session)
      if (interval !== undefined) resetSilence(interval.silence)
      return null
    },
  }))

  // Soft reminders compose with downstream post-execute policy and never deny a
  // call. The disclosure tool itself is accounting-neutral: executing it already
  // opened a new interval, and treating it as work would immediately consume one
  // call of that fresh interval.
  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const interval = exec.agent === undefined ? undefined : intervals.get(exec.agent.session)
    const observe = (): number | null => {
      if (interval === undefined || exec.name === DISCLOSURE_TOOL_NAME) return null
      recordActivity(interval.activity, classifyToolActivity(exec.name))
      return countCompletedCall(interval.silence, config.reminderAfterCalls, config.maxReminders, {
        nested: exec.parent !== undefined,
      })
    }

    let downstream: PostToolDecision
    try {
      downstream = await next()
    } catch (error) {
      observe()
      throw error
    }

    if (interval === undefined || exec.name === DISCLOSURE_TOOL_NAME) return downstream
    const index = observe()
    if (index === null) return downstream

    const activityFact = inspectionActivityFact(interval.activity, config.inspectionHintMinInspections)
    markReminderDelivered(interval.silence, interval.silence.calls, index)
    return withReminder(downstream, notice(reminderTextFor(index, activityFact)))
  })
}
