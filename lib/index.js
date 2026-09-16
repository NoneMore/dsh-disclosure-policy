import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
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
} from './policy.js'
export const name = 'todo-checkpoint-guard'
export const inject = ['tools']
export const Config = z.object({
  reminderAfterCalls: z.number().step(1).min(1).default(6),
  blockAfterCalls: z.number().step(1).min(2).default(10),
  progressReminderAfterCalls: z.number().step(1).min(1).default(8),
  progressBlockAfterCalls: z.number().step(1).min(2).default(12),
  progressMinChars: z.number().step(1).min(1).default(24),
  installProgressPolicy: z.boolean().default(true),
  reconcileOnTurnStop: z.boolean().default(true),
  exemptTools: z.array(z.string().min(1)).default([]),
})
const SOURCE = {
  kind: 'plugin',
  plugin: name,
  form: 'notice',
  summary: 'Progress checkpoint',
}
function notice(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: SOURCE,
  })
}
function prependContext(ours, existing) {
  return existing === undefined ? [ours] : [ours, ...existing]
}
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const exemptTools = new Set(config.exemptTools)
  const todoStates = new WeakMap()
  const progressStates = new WeakMap()
  const reminders = new WeakMap()
  const reconciledTurns = new WeakMap()
  let epoch = 0
  const activateFromTodos = (session, todos) => {
    if (!hasUnfinishedTodos(todos)) {
      todoStates.delete(session)
      return
    }
    todoStates.set(session, { calls: 0, epoch: ++epoch, todos })
  }
  const resetProgress = (session, turn) => {
    progressStates.set(session, { calls: 0, epoch: ++epoch, turn })
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
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
      if (isMeaningfulVisibleAssistant(event.data.message.content, config.progressMinChars)) {
        resetProgress(session, event.data.turn)
      } else if (!progressStates.has(session)) {
        resetProgress(session, event.data.turn)
      }
    }
  })
  if (config.installProgressPolicy) {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined) {
      ctx.effect(() => systemPrompt.section({
        name: 'plugin:todo-checkpoint-guard:progress-policy',
        order: 10150,
        text: PROGRESS_POLICY_TEXT,
      }))
    }
  }
  ctx.effect(() => ctx.tools.guard((exec) => {
    const agent = exec.agent
    if (agent === undefined) return
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
    const reservation = { session }
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
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const downstream = await next()
    const reservation = reminders.get(exec)
    if (reservation === undefined) return downstream
    reminders.delete(exec)
    const currentTodo = reservation.todoState !== undefined && todoStates.get(reservation.session) === reservation.todoState
      ? reservation.todoCalls
      : undefined
    const currentProgress = reservation.progressState !== undefined && progressStates.get(reservation.session) === reservation.progressState
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
      reconciledTurns.set(agent.session, turn)
      agent.steer(notice(STOP_RECONCILE_TEXT))
    })
  }
}
export { TODO_WRITE_NAME }
