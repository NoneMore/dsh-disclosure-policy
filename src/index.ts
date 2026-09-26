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
  /** Completed top-level non-disclosure calls per reminder period. 0 disables reminders. Default 8. */
  reminderAfterCalls?: number
  /** Reminder budget per disclosure interval. 0 disables reminders. Default 3. */
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
  summary: 'Progress checkpoint reminder',
}

function notice(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text' as const, text }],
    source: SOURCE,
  })
}

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
export function apply(ctx: Context, rawConfig: Config = {}): void {
  const config = resolveConfig(rawConfig)
  const intervals = new WeakMap<Session, IntervalState>()

  ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'turn/start':
        intervals.set(session, {
          silence: createSilence(),
          activity: createActivity(config.activityWindowSize),
        })
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
    description: DISCLOSURE_TOOL_DESCRIPTION,
    parameters: {
      done: { type: 'string', required: true },
      next: { type: 'string', required: true },
      approach: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'null' },
      // The model already authored the useful information in the arguments.
      // Returning no content avoids echoing it back into the next request.
      render: () => [],
    },
    async execute(_args, exec) {
      const interval = exec.agent === undefined ? undefined : intervals.get(exec.agent.session)
      if (interval !== undefined) resetSilence(interval.silence)
      return null
    },
  }))

  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const interval = exec.agent === undefined ? undefined : intervals.get(exec.agent.session)

    // disclose_progress is the boundary itself. It neither enters the activity
    // window nor advances the cadence; its executor has already reset accounting.
    if (exec.name === DISCLOSURE_TOOL_NAME) return await next()

    const observe = (): number | null => {
      if (interval === undefined) return null
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

    if (interval === undefined) return downstream
    const index = observe()
    if (index === null) return downstream

    const activityFact = inspectionActivityFact(interval.activity, config.inspectionHintMinInspections)
    markReminderDelivered(interval.silence, interval.silence.calls, index)
    return withReminder(downstream, notice(reminderTextFor(index, activityFact)))
  })
}
