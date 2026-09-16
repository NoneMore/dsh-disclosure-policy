import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'
import {
  countCompletedCall,
  createSilence,
  DEFAULT_CONFIG,
  DISCLOSURE_PLUGIN_NAME,
  DISCLOSURE_POLICY_ORDER,
  DISCLOSURE_POLICY_SECTION_NAME,
  DISCLOSURE_POLICY_TEXT,
  DISCLOSURE_REMINDER_TEXT,
  isModelDisclosure,
  resetSilence,
  resolveConfig,
  withReminder,
  type SilenceState,
} from './policy.js'

// Declaration-merging side effects keep current DSH event/service names typed.
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

export const name = DISCLOSURE_PLUGIN_NAME
export const inject = ['tools']

export interface Config {
  /**
   * Completed top-level tool calls in one silence interval before the single
   * soft reminder. `0` disables runtime reminders while keeping the standing
   * policy. Default 8.
   */
  reminderAfterCalls?: number
}

export const Config: z<Config> = z.object({
  reminderAfterCalls: z.number().step(1).min(0).default(DEFAULT_CONFIG.reminderAfterCalls),
})

const SOURCE = {
  kind: 'plugin' as const,
  plugin: DISCLOSURE_PLUGIN_NAME,
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
 * Two extension points only:
 *
 * - `session/event` maintains one turn-local silence interval per session from
 *   first-party durable facts;
 * - `tools/post-execute` counts settled top-level calls and appends at most one
 *   soft reminder per interval as next-step context.
 *
 * The standing policy is a static prompt section. No guard is registered, no
 * task state is read or written, and nothing is steered from an event callback:
 * see ADR-0001 and ADR-0003. The runtime keeps live projections instead of
 * scanning session history, which current DSH policy requires for new code; a
 * hot reload mid-turn therefore starts accounting at the next `turn/start`.
 */
export function apply(ctx: Context, rawConfig: Config = {}): void {
  const config = resolveConfig(rawConfig)
  const silences = new WeakMap<Session, SilenceState>()

  ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'turn/start':
        silences.set(session, createSilence())
        return
      case 'turn/end':
        silences.delete(session)
        return
      case 'assistant/message': {
        const state = silences.get(session)
        if (state === undefined) return
        // Model-authored visible text opens a new interval. Reasoning blocks
        // and plugin-authored messages are not disclosure and never reset it.
        if (isModelDisclosure(event.data.message)) resetSilence(state)
        return
      }
      default:
        return
    }
  })

  // The prompt service is optional by design: `inject` is for hard
  // requirements, so the capability is probed with ctx.get(). A deployment that
  // installs a complete replacement prompt may suppress this section; the
  // reminder keeps working.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: DISCLOSURE_POLICY_SECTION_NAME,
      order: DISCLOSURE_POLICY_ORDER,
      text: DISCLOSURE_POLICY_TEXT,
    }))
  }

  // The single soft reminder. It composes with downstream post-execute policy
  // (accept or block) rather than replacing it, and it never denies a call.
  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const downstream = await next()
    const state = exec.agent === undefined ? undefined : silences.get(exec.agent.session)
    if (state === undefined) return downstream

    const remind = countCompletedCall(state, config.reminderAfterCalls, {
      nested: exec.parent !== undefined,
    })
    if (!remind) return downstream

    return withReminder(downstream, notice(DISCLOSURE_REMINDER_TEXT))
  })
}
