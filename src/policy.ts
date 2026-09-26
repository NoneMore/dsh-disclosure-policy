/**
 * Pure disclosure policy.
 *
 * The host adapter owns tool registration. This module contains only lightweight
 * accounting, activity classification, and reminder composition so it stays
 * testable without the DeepSeek Harness dependency graph.
 */

/** Package/plugin identity carried by every notice this policy emits. */
export const DISCLOSURE_PLUGIN_NAME = 'disclosure-policy'

/** Model-facing progress action registered by the host adapter. */
export const DISCLOSURE_TOOL_NAME = 'disclose_progress'

/**
 * The tool schema is the standing model-facing contract. Keep this short because
 * it is present in every request that exposes the tool.
 */
export const DISCLOSURE_TOOL_DESCRIPTION =
  'Progress checkpoint: briefly report done, next, approach. If work remains, call alongside the next work tool(s).'

/**
 * Historical prompt exports remain for policy-API compatibility. The host plugin
 * no longer mounts this section, so they add zero model-context cost.
 */
export const DISCLOSURE_POLICY_ORDER = 10150
export const DISCLOSURE_POLICY_SECTION_NAME = 'plugin:disclosure-policy:policy'
export const DISCLOSURE_POLICY_TEXT = DISCLOSURE_TOOL_DESCRIPTION

export interface DisclosureConfig {
  /**
   * Completed top-level work calls that advance the reminder cadence by one
   * position. `0` disables runtime reminders while keeping the disclosure tool.
   */
  reminderAfterCalls: number
  /**
   * Reminder budget for one disclosure interval. `1` is a one-shot reminder;
   * `0` disables reminders.
   */
  maxReminders: number
  /** Recent observed operations retained for activity hints; 0 disables hints alone. */
  activityWindowSize: number
  /** Minimum inspections in the activity window, independent of reminder cadence. */
  inspectionHintMinInspections: number
}

export const DEFAULT_CONFIG: Readonly<DisclosureConfig> = Object.freeze({
  reminderAfterCalls: 8,
  maxReminders: 3,
  activityWindowSize: 16,
  inspectionHintMinInspections: 8,
})

export type ActivityKind = 'inspect' | 'mutate' | 'verify' | 'other'

export interface ActivityState {
  inspect: number
  mutate: number
  verify: number
  other: number
  readonly windowSize: number
  readonly operations: ActivityKind[]
  next: number
}

const OPEN_ACTIVITY = Object.freeze({ inspect: 0, mutate: 0, verify: 0, other: 0 })

const INSPECT_TOKENS = new Set([
  'browse', 'diff', 'fetch', 'find', 'glob', 'grep', 'inspect', 'list', 'log', 'open', 'read', 'search', 'show', 'status',
])
const MUTATE_TOKENS = new Set([
  'apply', 'copy', 'create', 'delete', 'edit', 'mkdir', 'move', 'patch', 'remove', 'rename', 'touch', 'update', 'write',
])
const VERIFY_TOKENS = new Set([
  'acceptance', 'benchmark', 'build', 'check', 'lint', 'pytest', 'test', 'typecheck', 'validate', 'validation', 'verify',
])

/** Bounded activity window, independent of disclosure intervals. */
export function createActivity(windowSize = DEFAULT_CONFIG.activityWindowSize): ActivityState {
  validateActivityWindowSize(windowSize)
  return { ...OPEN_ACTIVITY, windowSize, operations: [], next: 0 }
}

function validateActivityWindowSize(windowSize: number): void {
  if (!Number.isSafeInteger(windowSize) || windowSize < 0) {
    throw new Error('disclosure-policy: activityWindowSize must be a non-negative safe integer')
  }
}

/** Explicitly clear the activity window; disclosure does not call this helper. */
export function resetActivity(state: ActivityState): ActivityState {
  Object.assign(state, OPEN_ACTIVITY)
  state.operations.length = 0
  state.next = 0
  return state
}

/** Classify one tool by its structured name only. */
export function classifyToolActivity(toolName: string): ActivityKind {
  const tokens = toolName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (tokens.some(token => VERIFY_TOKENS.has(token))) return 'verify'
  if (tokens.some(token => MUTATE_TOKENS.has(token))) return 'mutate'
  if (tokens.some(token => INSPECT_TOKENS.has(token))) return 'inspect'
  return 'other'
}

/** Observe one operation, evicting the oldest when the window is full. */
export function recordActivity(state: ActivityState, kind: ActivityKind): ActivityState {
  if (state.windowSize === 0) return state
  if (state.operations.length === state.windowSize) {
    state[state.operations[state.next]] -= 1
    state.operations[state.next] = kind
  } else {
    state.operations.push(kind)
  }
  state.next = (state.next + 1) % state.windowSize
  state[kind] += 1
  return state
}

/**
 * Objective context for an inspection-only stretch, or `null` when the shape
 * is not notable enough to add to the ordinary reminder.
 */
export function inspectionActivityFact(state: ActivityState, minimumInspections: number): string | null {
  if (
    minimumInspections <= 0
    || state.inspect < minimumInspections
    || state.mutate !== 0
    || state.verify !== 0
  ) {
    return null
  }
  return `Recent window: ${state.inspect}/${state.operations.length} inspection/search, 0 mutation/verification by tool-name classification. If investigating further, name the unresolved fact.`
}

/** Resolve and validate behavioral options. */
export function resolveConfig(input: Partial<DisclosureConfig> = {}): DisclosureConfig {
  const reminderAfterCalls = input.reminderAfterCalls ?? DEFAULT_CONFIG.reminderAfterCalls
  const maxReminders = input.maxReminders ?? DEFAULT_CONFIG.maxReminders
  const {
    activityWindowSize = DEFAULT_CONFIG.activityWindowSize,
    inspectionHintMinInspections = DEFAULT_CONFIG.inspectionHintMinInspections,
  } = input
  if (!Number.isSafeInteger(reminderAfterCalls) || reminderAfterCalls < 0) {
    throw new Error('disclosure-policy: reminderAfterCalls must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(maxReminders) || maxReminders < 0) {
    throw new Error('disclosure-policy: maxReminders must be a non-negative safe integer')
  }
  validateActivityWindowSize(activityWindowSize)
  if (!Number.isSafeInteger(inspectionHintMinInspections) || inspectionHintMinInspections <= 0) {
    throw new Error('disclosure-policy: inspectionHintMinInspections must be a positive safe integer')
  }
  if (activityWindowSize > 0 && inspectionHintMinInspections > activityWindowSize) {
    throw new Error('disclosure-policy: inspectionHintMinInspections must not exceed activityWindowSize')
  }
  return Object.freeze({ reminderAfterCalls, maxReminders, activityWindowSize, inspectionHintMinInspections })
}

export interface ContentBlockLike {
  readonly type: string
  readonly text?: unknown
}

export interface MessageLike {
  readonly role?: string
  readonly source?: { readonly kind?: string }
  readonly content: readonly ContentBlockLike[]
}

/**
 * Legacy visibility helpers retained for API compatibility. Runtime disclosure
 * accounting no longer uses Assistant prose recognition.
 */
export function hasVisibleText(content: readonly ContentBlockLike[]): boolean {
  return content.some(block => block.type === 'text'
    && typeof block.text === 'string'
    && block.text.trim() !== '')
}

const LEGACY_DISCLOSURE_LABEL_SETS = [
  ['Disclosure', 'Done', 'Next', 'Approach'],
  ['披露', '已做', '将做', '做法'],
] as const

/** @deprecated Runtime disclosure is now the `disclose_progress` tool action. */
export function isModelDisclosure(message: MessageLike): boolean {
  if (message.role !== 'assistant' || message.source?.kind !== 'model') return false
  const text = message.content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
  const rawLines = text.split(/\r\n|\n|\r/)
  const first = rawLines.findIndex(line => line.trim() !== '')
  if (first === -1) return false
  const last = rawLines.findLastIndex(line => line.trim() !== '')
  const lines = rawLines.slice(first, last + 1)
  if (lines.length !== 4) return false
  if (lines.every(line => /^(?: {4}| {0,3}\t)/.test(line))) return false
  return LEGACY_DISCLOSURE_LABEL_SETS.some(labels => lines.every((line, index) => {
    const field = /^([^:：]+)[:：](.*)$/.exec(line.trim())
    if (field === null || field[1].trim() !== labels[index]) return false
    return index === 0 ? field[2].trim() === '' : field[2].trim() !== ''
  }))
}

/**
 * One turn-local disclosure interval: completed top-level work calls since the
 * latest successful `disclose_progress` execution.
 */
export interface SilenceState {
  /** Completed top-level work calls since the interval opened. */
  calls: number
  /** Call count where this interval's first reminder was actually delivered. */
  firstReminderAt: number | null
  /** Reminders delivered in this interval, and the budget index of the next one. */
  delivered: number
}

const OPEN_INTERVAL = Object.freeze({ calls: 0, firstReminderAt: null, delivered: 0 })

export function createSilence(): SilenceState {
  return { ...OPEN_INTERVAL }
}

/** Open a new reminder interval in place. */
export function resetSilence(state: SilenceState): SilenceState {
  Object.assign(state, OPEN_INTERVAL)
  return state
}

/**
 * Count one completed top-level work call and report which reminder it carries.
 * Nested calls inside a composite tool do not advance cadence.
 */
export function countCompletedCall(
  state: SilenceState,
  reminderAfterCalls: number,
  maxReminders: number,
  options: { readonly nested?: boolean } = {},
): number | null {
  if (options.nested === true) return null

  state.calls += 1
  if (reminderAfterCalls <= 0 || maxReminders <= 0) return null

  const index = state.delivered
  if (index >= maxReminders) return null

  const dueAt = state.firstReminderAt === null
    ? reminderAfterCalls
    : state.firstReminderAt + index * reminderAfterCalls
  if (state.calls < dueAt) return null

  return index
}

/** Record that a reminder was actually delivered. */
export function markReminderDelivered(state: SilenceState, calls: number, index: number): void {
  if (state.firstReminderAt === null) state.firstReminderAt = calls
  state.delivered = index + 1
}

export interface ReminderCarrier<TNotice> {
  readonly kind: string
  readonly additionalContexts?: readonly TNotice[]
}

/** Prepend one reminder without replacing any downstream decision fields. */
export function withReminder<TNotice, TDecision extends ReminderCarrier<TNotice>>(
  decision: TDecision,
  reminder: TNotice,
): TDecision {
  const existing = decision.additionalContexts
  const additionalContexts = existing === undefined ? [reminder] : [reminder, ...existing]
  return { ...decision, additionalContexts } as TDecision
}

/**
 * Runtime reminder text is intentionally tiny. The standing behavioral contract
 * lives in the `disclose_progress` tool schema, which the model already receives,
 * so repeating field-format instructions here would spend tokens twice.
 */
export const DISCLOSURE_REMINDER_TEXT =
  '[disclosure] Call disclose_progress now with a brief checkpoint; if work remains, batch it with the next work tool(s).'

export const DISCLOSURE_REPEAT_TEXT =
  'Repeat reminder: no disclose_progress call has been observed in this stretch.'

export function reminderTextFor(index: number, activityFact: string | null = null): string {
  const parts = [DISCLOSURE_REMINDER_TEXT]
  if (activityFact !== null) parts.push(activityFact)
  if (index > 0) parts.push(DISCLOSURE_REPEAT_TEXT)
  return parts.join(' ')
}
