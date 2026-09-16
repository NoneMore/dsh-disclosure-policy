import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, TodoItem } from '@deepseek-ai/dsh-session'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  combinedBlockedReason,
  combinedReminderText,
  hasUnfinishedTodos,
  isMeaningfulVisibleAssistant,
  PROGRESS_POLICY_TEXT,
  resolveConfig,
  shouldCountTool,
  STOP_RECONCILE_TEXT,
  TODO_WRITE_NAME,
  type GuardConfig,
} from './policy.js'

// Declaration-merging side effects keep current DSH event/service names typed.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'todo-checkpoint-guard'
export const inject = ['tools']

export interface Config {
  /** TODO soft reminder after this many ordinary tool calls. Default 6. */
  reminderAfterCalls?: number
  /** TODO hard checkpoint after this many calls without todo_write. Default 10. */
  blockAfterCalls?: number
  /** Progress soft reminder after this many calls without substantive visible assistant text. Default 8. */
  progressReminderAfterCalls?: number
  /** Progress hard checkpoint after this many calls without substantive visible assistant text. Default 12. */
  progressBlockAfterCalls?: number
  /** Coarse anti-empty-status threshold for visible assistant text. Default 24 non-whitespace Unicode chars. */
  progressMinChars?: number
  /** Install a persistent progress-communication prompt section when ctx.systemPrompt exists. Default true. */
  installProgressPolicy?: boolean
  /** Force one final TODO reconciliation step at the turn-stopping boundary. Default true. */
  reconcileOnTurnStop?: boolean
  /** Tool names that should consume neither freshness budget. */
  exemptTools?: string[]
}

export const Config: z<Config> = z.object({
  reminderAfterCalls: z.number().step(1).min(1).default(6),
  blockAfterCalls: z.number().step(1).min(2).default(10),
  progressReminderAfterCalls: z.number().step(1).min(1).default(8),
  progressBlockAfterCalls: z.number().step(1).min(2).default(12),
  progressMinChars: z.number().step(1).min(1).default(24),
  installProgressPolicy: z.boolean().default(true),
  reconcileOnTurnStop: z.boolean().default(true),
  exemptTools: z.array(z.string().min(1)).default([]),
})

interface TodoFreshnessState {
  /** Number of admitted ordinary calls since the latest unfinished todo/write. */
  calls: number
  /** Identity used to suppress reminders that became stale while a tool was running. */
  epoch: number
  /** Last complete todo snapshot observed from the live durable event stream. */
  todos: readonly TodoItem[]
}

interface ProgressFreshnessState {
  /** Number of admitted ordinary calls since the latest substantive visible assistant text. */
  calls: number
  /** Identity used to suppress reminders invalidated by a later assistant message. */
  epoch: number
  /** Turn owning this communication budget. */
  turn: number
}

interface ReminderReservation {
  session: Session
  todoState?: TodoFreshnessState
  todoCalls?: number
  progressState?: ProgressFreshnessState
  progressCalls?: number
}

const SOURCE = {
  kind: 'plugin' as const,
  plugin: name,
  form: 'notice' as const,
  summary: 'Progress checkpoint',
}

function notice(text: string) {
  return createUserMessage({
    content: [{ type: 'text' as const, text }],
    source: SOURCE,
  })
}

function prependContext(
  ours: ReturnType<typeof notice>,
  existing: PostToolDecision['additionalContexts'],
) {
  return existing === undefined ? [ours] : [ours, ...existing]
}

/**
 * v0.2 deliberately maintains live projections instead of synchronously scanning
 * Session history. Current DSH prohibits new production calls to eventAt(),
 * snapshotEvents(), and ownEvents(). A hot reload mid-turn therefore starts the
 * communication budget from the next observed assistant/message, and TODO
 * enforcement from the next todo/write.
 */
export function apply(ctx: Context, rawConfig: Config = {}): void {
  const config: GuardConfig = resolveConfig(rawConfig)
  const exemptTools = new Set(config.exemptTools)
  const todoStates = new WeakMap<Session, TodoFreshnessState>()
  const progressStates = new WeakMap<Session, ProgressFreshnessState>()
  const reminders = new WeakMap<ToolExecution, ReminderReservation>()
  const reconciledTurns = new WeakMap<Session, number>()
  let epoch = 0

  const activateFromTodos = (session: Session, todos: readonly TodoItem[]): void => {
    if (!hasUnfinishedTodos(todos)) {
      todoStates.delete(session)
      return
    }
    todoStates.set(session, { calls: 0, epoch: ++epoch, todos })
  }

  const resetProgress = (session: Session, turn: number): void => {
    progressStates.set(session, { calls: 0, epoch: ++epoch, turn })
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      // Native todo projection clears standing state on a new turn. Communication
      // freshness is turn-local, so start it immediately even before first text.
      todoStates.delete(session)
      resetProgress(session, event.data.turn)
      reconciledTurns.delete(session)
      return
    }

    if (event.type === 'turn/end') {
      todoStates.delete(session)
      progressStates.delete(session)
      return
    }

    if (event.type === 'todo/write') {
      activateFromTodos(session, event.data.todos)
      return
    }

    if (event.type === 'assistant/message') {
      // DSH commits assistant/message before dispatching that message's tool calls.
      // Therefore a substantive text + tool-call assistant message naturally
      // satisfies a hard communication checkpoint before its tools reach guards.
      if (isMeaningfulVisibleAssistant(event.data.message.content, config.progressMinChars)) {
        resetProgress(session, event.data.turn)
      } else if (!progressStates.has(session)) {
        // Covers hot-load into an active turn without scanning historical events.
        resetProgress(session, event.data.turn)
      }
    }
  })

  if (config.installProgressPolicy) {
    // systemPrompt is intentionally optional. Cordis inject is for hard
    // requirements; current DSH docs recommend ctx.get() for optional services.
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined) {
      ctx.effect(() => systemPrompt.section({
        name: 'plugin:todo-checkpoint-guard:progress-policy',
        // External contributions may use any finite order. Place this after the
        // normal Web-surface guidance and before deployment persona suffix (10200).
        order: 10150,
        text: PROGRESS_POLICY_TEXT,
      }))
    }
  }

  // A guard is monotonic: later waterfall policy cannot force-allow a call this
  // plugin denied. Register its disposer as an effect for clean HMR unload.
  ctx.effect(() => ctx.tools.guard((exec) => {
    const agent = exec.agent
    if (agent === undefined) return

    // todo_write must always remain reachable, including when communication is
    // stale. It repairs task accounting but deliberately does NOT reset the
    // communication budget; a progress update is a separate human-facing lane.
    if (exec.name === TODO_WRITE_NAME) return
    if (!shouldCountTool(exec.name, exec.parent !== undefined, exemptTools, RUN_CODE_NAME)) return

    const session = agent.session
    const todoState = todoStates.get(session)
    const progressState = progressStates.get(session)

    const todoBlocked = todoState !== undefined && todoState.calls >= config.blockAfterCalls
    const progressBlocked = progressState !== undefined && progressState.calls >= config.progressBlockAfterCalls

    if (todoBlocked || progressBlocked) {
      return combinedBlockedReason({
        todoCalls: todoBlocked ? todoState?.calls : undefined,
        progressCalls: progressBlocked ? progressState?.calls : undefined,
        config,
      })
    }

    const reservation: ReminderReservation = { session }
    let shouldReserve = false

    if (todoState !== undefined) {
      todoState.calls += 1
      if (todoState.calls === config.reminderAfterCalls) {
        reservation.todoState = todoState
        reservation.todoCalls = todoState.calls
        shouldReserve = true
      }
    }

    if (progressState !== undefined) {
      progressState.calls += 1
      if (progressState.calls === config.progressReminderAfterCalls) {
        reservation.progressState = progressState
        reservation.progressCalls = progressState.calls
        shouldReserve = true
      }
    }

    if (shouldReserve) reminders.set(exec, reservation)
  }))

  // Soft reminders are logged plugin-sourced model context. They arrive on the
  // next model step without pretending to be human speech and without creating a
  // synthetic assistant UI message. The model itself must emit the mid-turn text.
  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const downstream = await next()
    const reservation = reminders.get(exec)
    if (reservation === undefined) return downstream
    reminders.delete(exec)

    const currentTodo = reservation.todoState !== undefined
      && todoStates.get(reservation.session) === reservation.todoState
      ? reservation.todoCalls
      : undefined
    const currentProgress = reservation.progressState !== undefined
      && progressStates.get(reservation.session) === reservation.progressState
      ? reservation.progressCalls
      : undefined

    if (currentTodo === undefined && currentProgress === undefined) return downstream

    const context = notice(combinedReminderText({
      todoCalls: currentTodo,
      progressCalls: currentProgress,
      config,
    }))
    return {
      ...downstream,
      additionalContexts: prependContext(context, downstream.additionalContexts),
    }
  })

  if (config.reconcileOnTurnStop) {
    ctx.on('agent/turn-stopping', ({ agent, turn }) => {
      const state = todoStates.get(agent.session)
      if (state === undefined || !hasUnfinishedTodos(state.todos)) return
      if (reconciledTurns.get(agent.session) === turn) return

      // Self-limit to one forced continuation per turn. turn-stopping is the
      // documented lifecycle boundary where a plugin may steer and cause another
      // step; doing this synchronously from session/event would re-enter append.
      reconciledTurns.set(agent.session, turn)
      agent.steer(notice(STOP_RECONCILE_TEXT))
    })
  }
}

export { TODO_WRITE_NAME }
