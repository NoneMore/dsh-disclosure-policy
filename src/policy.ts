export const TODO_WRITE_NAME = 'todo_write'

export interface GuardConfig {
  /** TODO soft reminder threshold. */
  reminderAfterCalls: number
  /** TODO hard checkpoint threshold. */
  blockAfterCalls: number
  /** Communication soft reminder threshold. */
  progressReminderAfterCalls: number
  /** Communication hard checkpoint threshold. */
  progressBlockAfterCalls: number
  /** Small anti-gaming heuristic for a visible assistant update. */
  progressMinChars: number
  /** Install a persistent model-facing progress communication policy when ctx.systemPrompt is available. */
  installProgressPolicy: boolean
  /** Force one bounded TODO reconciliation before a turn closes with unfinished items. */
  reconcileOnTurnStop: boolean
  /** Tool names that consume neither freshness budget. */
  exemptTools: readonly string[]
}

export const DEFAULT_CONFIG: GuardConfig = Object.freeze({
  reminderAfterCalls: 6,
  blockAfterCalls: 10,
  progressReminderAfterCalls: 8,
  progressBlockAfterCalls: 12,
  progressMinChars: 24,
  installProgressPolicy: true,
  reconcileOnTurnStop: true,
  exemptTools: Object.freeze([]),
})

export interface TodoLike {
  readonly status: string
}

export interface ContentBlockLike {
  readonly type: string
  readonly text?: unknown
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`todo-checkpoint-guard: ${name} must be a positive safe integer`)
  }
  return value
}

function validateThresholdPair(reminderName: string, reminder: number, blockName: string, block: number): void {
  if (block <= reminder) {
    throw new Error(`todo-checkpoint-guard: ${blockName} must be greater than ${reminderName}`)
  }
}

export function resolveConfig(input: Partial<GuardConfig> = {}): GuardConfig {
  const reminderAfterCalls = positiveInteger(
    'reminderAfterCalls',
    input.reminderAfterCalls ?? DEFAULT_CONFIG.reminderAfterCalls,
  )
  const blockAfterCalls = positiveInteger(
    'blockAfterCalls',
    input.blockAfterCalls ?? DEFAULT_CONFIG.blockAfterCalls,
  )
  const progressReminderAfterCalls = positiveInteger(
    'progressReminderAfterCalls',
    input.progressReminderAfterCalls ?? DEFAULT_CONFIG.progressReminderAfterCalls,
  )
  const progressBlockAfterCalls = positiveInteger(
    'progressBlockAfterCalls',
    input.progressBlockAfterCalls ?? DEFAULT_CONFIG.progressBlockAfterCalls,
  )
  const progressMinChars = positiveInteger(
    'progressMinChars',
    input.progressMinChars ?? DEFAULT_CONFIG.progressMinChars,
  )

  validateThresholdPair('reminderAfterCalls', reminderAfterCalls, 'blockAfterCalls', blockAfterCalls)
  validateThresholdPair(
    'progressReminderAfterCalls',
    progressReminderAfterCalls,
    'progressBlockAfterCalls',
    progressBlockAfterCalls,
  )

  const rawExemptTools = input.exemptTools ?? DEFAULT_CONFIG.exemptTools
  const exemptTools = [...new Set(rawExemptTools.map(value => value.trim()).filter(Boolean))]

  return Object.freeze({
    reminderAfterCalls,
    blockAfterCalls,
    progressReminderAfterCalls,
    progressBlockAfterCalls,
    progressMinChars,
    installProgressPolicy: input.installProgressPolicy ?? DEFAULT_CONFIG.installProgressPolicy,
    reconcileOnTurnStop: input.reconcileOnTurnStop ?? DEFAULT_CONFIG.reconcileOnTurnStop,
    exemptTools: Object.freeze(exemptTools),
  })
}

export function hasUnfinishedTodos(todos: readonly TodoLike[]): boolean {
  return todos.some(todo => todo.status !== 'completed')
}

/**
 * Return a coarse length for user-visible assistant text.
 *
 * This is deliberately NOT an information-quality score. It only prevents a
 * tiny acknowledgement such as "继续" / "working" from resetting the runtime
 * freshness budget. The prompt policy carries the semantic obligation.
 */
export function visibleAssistantTextLength(content: readonly ContentBlockLike[]): number {
  const normalized = content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => (block.text as string).replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join(' ')
  return Array.from(normalized.replace(/\s/gu, '')).length
}

export function isMeaningfulVisibleAssistant(
  content: readonly ContentBlockLike[],
  minChars: number,
): boolean {
  return visibleAssistantTextLength(content) >= minChars
}

export function shouldCountTool(
  toolName: string,
  hasParent: boolean,
  exemptTools: ReadonlySet<string>,
  runCodeName = 'run_code',
): boolean {
  if (toolName === TODO_WRITE_NAME) return false
  // In PTC/code mode, count the nested native tool calls rather than the outer
  // transport call. Otherwise one run_code containing many sub-dispatches would
  // look like a single unit of work to both freshness guards.
  if (toolName === runCodeName && !hasParent) return false
  if (exemptTools.has(toolName)) return false
  return true
}

export function todoBlockedReason(calls: number, blockAfterCalls: number): string {
  return [
    `TODO checkpoint required: ${calls} ordinary tool calls have run since the last todo_write while unfinished work remains.`,
    `The configured TODO freshness budget is ${blockAfterCalls}.`,
    'Call todo_write now with the COMPLETE reconciled list before using another ordinary tool.',
    'Reflect reality: mark finished items completed, the work actually being done in_progress, and newly discovered work pending. Do not batch-complete unfinished items just to pass the guard.',
  ].join(' ')
}

export function todoReminderText(calls: number, blockAfterCalls: number): string {
  return [
    `[todo checkpoint] ${calls} ordinary tool calls have run since the last todo_write and unfinished items still exist.`,
    `Reconcile the COMPLETE todo list soon; ordinary tools will be blocked after ${blockAfterCalls} calls without a fresh todo_write.`,
    'Update completed items as soon as they are actually done and keep current work in_progress.',
  ].join(' ')
}

export function progressBlockedReason(
  calls: number,
  blockAfterCalls: number,
  minChars: number,
): string {
  return [
    `Progress checkpoint required: ${calls} ordinary tool calls have run since the last substantive user-visible assistant update.`,
    `The configured communication freshness budget is ${blockAfterCalls}.`,
    'Before or with the next ordinary tool call, emit 1-2 concise user-visible sentences containing concrete new facts: what you learned or completed, any important plan change/blocker, and what you will do next and why.',
    `The runtime only resets this fallback counter for visible text of at least ${minChars} non-whitespace Unicode characters; this is a coarse anti-empty-status heuristic, not a quality score.`,
    'Do not expose chain-of-thought. Report conclusions, evidence, decisions, blockers, and next actions.',
  ].join(' ')
}

export function progressReminderText(calls: number, blockAfterCalls: number): string {
  return [
    `[progress checkpoint] ${calls} ordinary tool calls have run since the last substantive user-visible assistant update.`,
    'On the next model step, give the user a short, high-information progress update before or alongside further substantial tool use.',
    'Include concrete new facts: what was learned/completed, any plan change or blocker, and what comes next and why. Empty status phrases such as “continuing” or “checking files” do not satisfy the intent.',
    `Ordinary tools will be blocked after ${blockAfterCalls} calls without a substantive visible update.`,
    'Do not expose chain-of-thought.',
  ].join(' ')
}

export function combinedBlockedReason(options: {
  readonly todoCalls?: number
  readonly progressCalls?: number
  readonly config: Pick<GuardConfig, 'blockAfterCalls' | 'progressBlockAfterCalls' | 'progressMinChars'>
}): string {
  const reasons: string[] = []
  if (options.todoCalls !== undefined) {
    reasons.push(todoBlockedReason(options.todoCalls, options.config.blockAfterCalls))
  }
  if (options.progressCalls !== undefined) {
    reasons.push(progressBlockedReason(
      options.progressCalls,
      options.config.progressBlockAfterCalls,
      options.config.progressMinChars,
    ))
  }
  return reasons.join('\n\n')
}

export function combinedReminderText(options: {
  readonly todoCalls?: number
  readonly progressCalls?: number
  readonly config: Pick<GuardConfig, 'blockAfterCalls' | 'progressBlockAfterCalls'>
}): string {
  const reminders: string[] = []
  if (options.todoCalls !== undefined) {
    reminders.push(todoReminderText(options.todoCalls, options.config.blockAfterCalls))
  }
  if (options.progressCalls !== undefined) {
    reminders.push(progressReminderText(options.progressCalls, options.config.progressBlockAfterCalls))
  }
  return reminders.join('\n\n')
}

export const PROGRESS_POLICY_TEXT = [
  '## Progress communication',
  '',
  'During substantial multi-step work, keep the user informed with short, high-information mid-turn updates.',
  'Send an update when a meaningful phase finishes, a discovery changes the approach, the plan changes, a verification/test produces a meaningful result, a blocker appears, you are about to enter another substantial stretch of tool use, or the runtime requests a progress checkpoint.',
  'A useful update should normally say what was learned or completed, what changed relative to the previous understanding when relevant, and what you will do next and why.',
  'Do not emit empty status phrases such as “I am continuing”, “I am checking the files”, or “I will proceed with the next step” unless they also contain concrete new information.',
  'Keep progress narration separate from task accounting: maintain todo_write truthfully when a TODO list exists.',
  'Do not expose chain-of-thought. Report only conclusions, evidence, decisions, blockers, and next actions.',
].join('\n')

export const STOP_RECONCILE_TEXT = [
  '[todo checkpoint] Before finalizing this turn, reconcile the current TODO list with the work that actually happened.',
  'If the list is stale, call todo_write once with the COMPLETE truthful list.',
  'Do not mark unfinished work completed merely to close the turn; preserve pending/in_progress items and explain any remaining work in the final response.',
  'Do not start new exploratory work solely to satisfy this checkpoint.',
].join(' ')
