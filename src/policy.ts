/**
 * Pure disclosure policy.
 *
 * Runtime disclosure is now a structured tool action rather than an Assistant
 * text shape. This module keeps reminder/activity accounting host-independent.
 */

/** Package/plugin identity carried by reminder notices. */
export const DISCLOSURE_PLUGIN_NAME = 'disclosure-policy'

/** Structured progress primitive registered by the host adapter. */
export const DISCLOSURE_TOOL_NAME = 'disclose_progress'

/**
 * Kept for policy-API compatibility. The plugin no longer mounts a separate
 * standing prompt section; the compact tool declaration carries this policy.
 */
export const DISCLOSURE_POLICY_ORDER = 10150
export const DISCLOSURE_POLICY_SECTION_NAME = 'plugin:disclosure-policy:policy'
export const DISCLOSURE_POLICY_TEXT =
  'During long autonomous work, use disclose_progress for brief supervisor checkpoints and continue unless blocked.'

/**
 * Keep this compact: tool declarations are fixed per-request context in native
 * mode and become generated SDK text in PTC mode.
 */
export const DISCLOSURE_TOOL_DESCRIPTION =
  'Checkpoint long autonomous work: report done, next, and approach; then continue unless blocked.'

export interface DisclosureConfig {
  /** Completed top-level non-disclosure calls per reminder period; 0 disables reminders. */
  reminderAfterCalls: number
  /** Reminder budget for one disclosure interval; 0 disables reminders. */
  maxReminders: number
  /** Recent operations retained for activity hints; 0 disables hints alone. */
  activityWindowSize: number
  /** Minimum inspections in the activity window, independent of cadence. */
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

export function createActivity(windowSize = DEFAULT_CONFIG.activityWindowSize): ActivityState {
  validateActivityWindowSize(windowSize)
  return { ...OPEN_ACTIVITY, windowSize, operations: [], next: 0 }
}

function validateActivityWindowSize(windowSize: number): void {
  if (!Number.isSafeInteger(windowSize) || windowSize < 0) {
    throw new Error('disclosure-policy: activityWindowSize must be a non-negative safe integer')
  }
}

export function resetActivity(state: ActivityState): ActivityState {
  Object.assign(state, OPEN_ACTIVITY)
  state.operations.length = 0
  state.next = 0
  return state
}

export function classifyToolActivity(toolName: string): ActivityKind {
  const tokens = toolName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (tokens.some(token => VERIFY_TOKENS.has(token))) return 'verify'
  if (tokens.some(token => MUTATE_TOKENS.has(token))) return 'mutate'
  if (tokens.some(token => INSPECT_TOKENS.has(token))) return 'inspect'
  return 'other'
}

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

/** Compact factual suffix used only when the normal reminder is already due. */
export function inspectionActivityFact(state: ActivityState, minimumInspections: number): string | null {
  if (
    minimumInspections <= 0
    || state.inspect < minimumInspections
    || state.mutate !== 0
    || state.verify !== 0
  ) return null

  return `Recent window: ${state.inspect}/${state.operations.length} inspection/search, 0 mutation/verification by tool-name classification. If investigating further, name the unresolved fact.`
}

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

/**
 * Legacy expression helpers retained for ./policy API compatibility.
 * Runtime accounting no longer inspects Assistant prose.
 */
export interface ContentBlockLike {
  readonly type: string
  readonly text?: unknown
}

export interface MessageLike {
  readonly role?: string
  readonly source?: { readonly kind?: string }
  readonly content: readonly ContentBlockLike[]
}

const DISCLOSURE_LABEL_SETS = [
  ['Disclosure', 'Done', 'Next', 'Approach'],
  ['披露', '已做', '将做', '做法'],
] as const

/** @deprecated Runtime disclosure uses disclose_progress instead. */
export function hasVisibleText(content: readonly ContentBlockLike[]): boolean {
  return content.some(block => block.type === 'text'
    && typeof block.text === 'string'
    && block.text.trim() !== '')
}

/** @deprecated Runtime disclosure uses disclose_progress instead. */
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
  return DISCLOSURE_LABEL_SETS.some(labels => lines.every((line, index) => {
    const field = /^([^:：]+)[:：](.*)$/.exec(line.trim())
    if (field === null || field[1].trim() !== labels[index]) return false
    return index === 0 ? field[2].trim() === '' : field[2].trim() !== ''
  }))
}

export interface SilenceState {
  calls: number
  firstReminderAt: number | null
  delivered: number
}

const OPEN_INTERVAL = Object.freeze({ calls: 0, firstReminderAt: null, delivered: 0 })

export function createSilence(): SilenceState {
  return { ...OPEN_INTERVAL }
}

export function resetSilence(state: SilenceState): SilenceState {
  Object.assign(state, OPEN_INTERVAL)
  return state
}

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
  return state.calls < dueAt ? null : index
}

export function markReminderDelivered(state: SilenceState, calls: number, index: number): void {
  if (state.firstReminderAt === null) state.firstReminderAt = calls
  state.delivered = index + 1
}

export interface ReminderCarrier<TNotice> {
  readonly kind: string
  readonly additionalContexts?: readonly TNotice[]
}

export function withReminder<TNotice, TDecision extends ReminderCarrier<TNotice>>(
  decision: TDecision,
  reminder: TNotice,
): TDecision {
  const existing = decision.additionalContexts
  return {
    ...decision,
    additionalContexts: existing === undefined ? [reminder] : [reminder, ...existing],
  } as TDecision
}

export const DISCLOSURE_REMINDER_TEXT =
  '[disclosure] Call disclose_progress with a brief done/next/approach checkpoint, then continue unless blocked.'

export const DISCLOSURE_REPEAT_TEXT =
  'Repeat reminder: no disclose_progress call has been observed in this interval.'

export function reminderTextFor(index: number, activityFact: string | null = null): string {
  const parts = [DISCLOSURE_REMINDER_TEXT]
  if (activityFact !== null) parts.push(activityFact)
  if (index > 0) parts.push(DISCLOSURE_REPEAT_TEXT)
  return parts.join(' ')
}
