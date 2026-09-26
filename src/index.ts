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
  currentStep: number | null
  progressAttemptStep: number | null
  checkpointStep: number | null
  reminderDeliveredStep: number | null
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
        intervals.set(session, {
          silence: createSilence(),
          activity: createActivity(config.activityWindowSize),
          currentStep: null,
          progressAttemptStep: null,
          checkpointStep: null,
          reminderDeliveredStep: null,
        })
        return
      case 'assistant/message': {
        const interval = intervals.get(session)
        if (interval === undefined) return
        interval.currentStep = event.data.step
        interval.checkpointStep = null
        interval.progressAttemptStep = event.data.message.content.some(block =>
          block.type === 'tool-call' && block.name === DISCLOSURE_TOOL_NAME)
          ? event.data.step
          : null
        return
      }
      case 'turn/end':
        intervals.delete(session)
        return
      default:
        return
    }
  })

  ctx.tools.register(defineTool({
    name: DISCLOSURE_TOOL_NAME,
    description: DISCLOSURE_TOOL_DESCRIPTION,
    parameters: {
      done: { type: 'string', required: true },
      next: { type: 'string', required: true },
      approach: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'null' },
      // The call arguments are the human-facing disclosure. Echoing them in the
      // result would duplicate context, so successful disclosure has no result text.
      render: () => [],
    },
    async execute(_args, exec) {
      const interval = exec.agent === undefined ? undefined : intervals.get(exec.agent.session)
      if (interval !== undefined) {
        resetSilence(interval.silence)
        interval.checkpointStep = interval.currentStep
        interval.progressAttemptStep = interval.currentStep
      }
      return null
    },
  }))

  // Soft reminders compose with downstream post-execute policy and never deny a
  // call. The disclosure tool itself is accounting-neutral: executing it already
  // opened a new interval, and treating it as work would immediately consume one
  // call of that fresh interval.
  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const interval = exec.agent === undefined ? undefined : intervals.get(exec.agent.session)

    // A direct call is advertised in assistant/message before sibling tools run.
    // A nested PTC call is not, so record the attempt here as well. Either way the
    // progress action itself is cadence/activity-neutral.
    if (exec.name === DISCLOSURE_TOOL_NAME) {
      if (interval !== undefined) interval.progressAttemptStep = interval.currentStep
      return next()
    }

    const observe = (): number | null => {
      if (interval === undefined) return null
      recordActivity(interval.activity, classifyToolActivity(exec.name))
      // A successful checkpoint makes every later settlement from the same model
      // step part of the checkpoint boundary, regardless of parallel settlement
      // order. Charge only work from a later model step to the fresh interval.
      if (interval.currentStep !== null && interval.checkpointStep === interval.currentStep) return null
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

    if (interval === undefined) return downstream
    const index = observe()
    if (index === null) return downstream

    const step = interval.currentStep
    // If this step is already trying to disclose, do not race it with a stale
    // reminder. Likewise, one model step can carry at most one reminder even if a
    // large parallel fan-out crosses several cadence periods.
    if (
      step !== null
      && (interval.progressAttemptStep === step || interval.reminderDeliveredStep === step)
    ) return downstream

    const activityFact = inspectionActivityFact(interval.activity, config.inspectionHintMinInspections)
    markReminderDelivered(interval.silence, interval.silence.calls, index)
    interval.reminderDeliveredStep = step
    return withReminder(downstream, notice(reminderTextFor(index, activityFact)))
  })
}
