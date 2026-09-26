/**
 * Pure disclosure policy.
 *
 * This module deliberately imports nothing from the host so the complete
 * behavior — disclosure accounting, reminder cadence, budget, and post-execute
 * composition — can be unit-tested without the DeepSeek Harness dependency
 * graph. `index.ts` is only the adapter that binds these decisions to Cordis
 * extension points.
 */

/** Package/plugin identity carried by every notice this policy emits. */
export const DISCLOSURE_PLUGIN_NAME = 'disclosure-policy'

/**
 * Static system-prompt order for the standing disclosure policy: after the
 * first-party Web-surface guidance (`WEB_SURFACE = 10100`) and before the
 * deployment persona suffix (`DEPLOYMENT_PERSONA_SUFFIX = 10200`).
 */
export const DISCLOSURE_POLICY_ORDER = 10150

/** Prompt-section name; unique within its layer. */
export const DISCLOSURE_POLICY_SECTION_NAME = 'plugin:disclosure-policy:policy'

export interface DisclosureConfig {
  /**
   * Completed top-level tool calls that advance the reminder cadence by one
   * position. `0` disables runtime reminders while keeping the standing policy.
   */
  reminderAfterCalls: number
  /**
   * Reminder budget for one disclosure interval: at most this many notices, one
   * every `reminderAfterCalls` completed top-level calls, after which the
   * interval gets no more reminders until structured disclosure opens a new one. `1` is the
   * historical one-shot cadence; `0` disables runtime reminders.
   */
  maxReminders: number
}

export const DEFAULT_CONFIG: Readonly<DisclosureConfig> = Object.freeze({
  reminderAfterCalls: 8,
  maxReminders: 3,
})

export type ActivityKind = 'inspect' | 'mutate' | 'verify' | 'other'

export interface ActivityState {
  inspect: number
  mutate: number
  verify: number
  other: number
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

/** Coarse activity counters for one disclosure interval. */
export function createActivity(): ActivityState {
  return { ...OPEN_ACTIVITY }
}

/** Recognized disclosure opens a new activity interval alongside the reminder interval. */
export function resetActivity(state: ActivityState): ActivityState {
  Object.assign(state, OPEN_ACTIVITY)
  return state
}

/**
 * Classify one tool by its structured name only.
 *
 * This intentionally stays conservative: generic shells and composite transports
 * are `other`; their nested native tools can still contribute their own activity.
 */
export function classifyToolActivity(toolName: string): ActivityKind {
  const tokens = toolName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (tokens.some(token => VERIFY_TOKENS.has(token))) return 'verify'
  if (tokens.some(token => MUTATE_TOKENS.has(token))) return 'mutate'
  if (tokens.some(token => INSPECT_TOKENS.has(token))) return 'inspect'
  return 'other'
}

/** Count one completed tool operation in the current activity interval. */
export function recordActivity(state: ActivityState, kind: ActivityKind): ActivityState {
  state[kind] += 1
  return state
}

/**
 * Objective context for an inspection-only stretch, or `null` when the shape
 * is not notable enough to add to the normal disclosure reminder.
 *
 * The fact does not say the work is excessive or unproductive. It only reports
 * the observed tool mix and asks the model to name the unresolved fact that
 * justifies more investigation.
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
  return `This stretch has included ${state.inspect} inspection/search tool operations and no mutation-oriented or verification-oriented tool operations. If more investigation is still needed, identify the unresolved fact it is intended to settle.`
}

/**
 * Resolve and validate the two behavioral options. The schema in `index.ts`
 * already rejects malformed DSH config rows; this second check keeps the pure
 * module authoritative and fails closed for direct callers.
 */
export function resolveConfig(input: Partial<DisclosureConfig> = {}): DisclosureConfig {
  const reminderAfterCalls = input.reminderAfterCalls ?? DEFAULT_CONFIG.reminderAfterCalls
  const maxReminders = input.maxReminders ?? DEFAULT_CONFIG.maxReminders
  if (!Number.isSafeInteger(reminderAfterCalls) || reminderAfterCalls < 0) {
    throw new Error('disclosure-policy: reminderAfterCalls must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(maxReminders) || maxReminders < 0) {
    throw new Error('disclosure-policy: maxReminders must be a non-negative safe integer')
  }
  return Object.freeze({ reminderAfterCalls, maxReminders })
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

const DISCLOSURE_LABEL_SETS = [
  ['Disclosure', 'Done', 'Next', 'Approach'],
  ['披露', '已做', '将做', '做法'],
] as const

/**
 * True when any visible `text` block carries a non-whitespace character.
 *
 * Reasoning blocks and whitespace-only text are not visible speech. Visibility
 * alone does not establish disclosure; see isModelDisclosure().
 */
export function hasVisibleText(content: readonly ContentBlockLike[]): boolean {
  return content.some(block => block.type === 'text'
    && typeof block.text === 'string'
    && block.text.trim() !== '')
}

/**
 * True when committed model-authored visible text has the agreed disclosure
 * structure. Recognition verifies expression only, never content quality.
 */
export function isModelDisclosure(message: MessageLike): boolean {
  if (message.role !== 'assistant') return false
  if (message.source?.kind !== 'model') return false
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
  // Preserve indentation until an entire Markdown code block is excluded.
  if (lines.every(line => /^(?: {4}| {0,3}\t)/.test(line))) return false
  return DISCLOSURE_LABEL_SETS.some(labels => lines.every((line, index) => {
    const field = /^([^:：]+)[:：](.*)$/.exec(line.trim())
    if (field === null || field[1].trim() !== labels[index]) return false
    return index === 0 ? field[2].trim() === '' : field[2].trim() !== ''
  }))
}

/**
 * One turn-local disclosure interval: completed top-level tool calls since the
 * last recognized structured disclosure. The exported name is retained for
 * compatibility with existing policy callers.
 *
 * The reminder budget belongs to this interval, so the interval — not the
 * individual reminder — is the unit that resets with structured disclosure.
 */
export interface SilenceState {
  /** Completed top-level tool calls since the interval opened. Never reset by a reminder. */
  calls: number
  /** Call count where this interval's first reminder was actually delivered; `null` means none yet. */
  firstReminderAt: number | null
  /** Reminders delivered in this interval, and the budget index of the next one. */
  delivered: number
}

/** The state of a freshly opened interval; the single source of the reset values. */
const OPEN_INTERVAL = Object.freeze({ calls: 0, firstReminderAt: null, delivered: 0 })

/** `turn/start` initializes the interval. */
export function createSilence(): SilenceState {
  return { ...OPEN_INTERVAL }
}

/**
 * Open a new interval in place: recognized disclosure (or a new turn) clears the
 * call count, the first-reminder anchor, and the delivered count, without
 * replacing the record.
 */
export function resetSilence(state: SilenceState): SilenceState {
  Object.assign(state, OPEN_INTERVAL)
  return state
}

/**
 * Count one completed top-level call and report which reminder it carries.
 *
 * Nested calls inside a composite tool never count. The result is independent of
 * whether the call succeeded, failed, or was denied by another policy, because
 * every settled call reaches the caller exactly once.
 *
 * The cadence is per interval, not per call: `null` means this call carries no
 * reminder, and a number selects the text (see {@link reminderTextFor}).
 * `markReminderDelivered` is a separate step on purpose — a boundary that throws
 * or is otherwise unable to deliver context must not consume a budget slot.
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

  // The first reminder lands at the threshold call and anchors the cadence; each
  // later one lands `reminderAfterCalls` calls after that anchor, which keeps
  // the cadence at one delivered reminder per period. A boundary that could not
  // deliver simply leaves the anchor unset, so the cadence starts at the next
  // boundary that can.
  const dueAt = state.firstReminderAt === null
    ? reminderAfterCalls
    : state.firstReminderAt + index * reminderAfterCalls
  if (state.calls < dueAt) return null

  return index
}

/**
 * Record that a reminder was actually delivered at call count `calls`.
 *
 * Called only where `additionalContexts` can carry the notice, so an interval's
 * budget is spent by delivered reminders rather than attempted ones.
 */
export function markReminderDelivered(state: SilenceState, calls: number, index: number): void {
  switch (state.firstReminderAt) {
    case null:
      state.firstReminderAt = calls
      break
    default:
      break
  }
  state.delivered = index + 1
}

export interface ReminderCarrier<TNotice> {
  readonly kind: string
  readonly additionalContexts?: readonly TNotice[]
}

/**
 * Compose one reminder into a downstream `tools/post-execute` decision.
 *
 * The decision is preserved rather than replaced: its kind and every other
 * field survive, our notice goes first, and contexts the downstream listener
 * supplied stay after ours.
 */
export function withReminder<TNotice, TDecision extends ReminderCarrier<TNotice>>(
  decision: TDecision,
  reminder: TNotice,
): TDecision {
  const existing = decision.additionalContexts
  const additionalContexts = existing === undefined ? [reminder] : [reminder, ...existing]
  // The spread keeps every downstream field; only the context list is extended.
  return { ...decision, additionalContexts } as TDecision
}

const DISCLOSURE_FORMAT_GUIDANCE = [
  'Use exactly four visible lines with one complete label set:',
  'Disclosure:',
  'Done: <recent work and its result or remaining uncertainty>',
  'Next: <immediate intended action>',
  'Approach: <concrete operations or verification>',
  'Or use the corresponding Chinese labels: 披露： / 已做： / 将做： / 做法：.',
  'Keep each field concise and non-empty. Use : or ：, without code fences, quotes, surrounding prose, or mixed label sets.',
  'No new conclusion is required. If execution has not started, say so; if unable to proceed, state the dependency and the conditional follow-up.',
].join('\n')

/**
 * The standing policy installed at {@link DISCLOSURE_POLICY_ORDER}.
 *
 * It states the semantic obligation — when disclosure is worth sending and what
 * it should answer — and nothing else. It carries no runtime state, no cadence,
 * and no enforcement.
 */
export const DISCLOSURE_POLICY_TEXT = [
  '## Disclosure',
  '',
  'You are executing a settled execution brief. Work autonomously, and disclose briefly whenever there is material new information for the supervisor, especially after:',
  '',
  '- confirming a finding;',
  '- completing a meaningful phase;',
  '- changing the settled plan or departing from a settled constraint;',
  '- obtaining a verification result;',
  '- encountering a blocker or material uncertainty; or',
  '- preparing to enter a clearly long stretch of work.',
  '',
  DISCLOSURE_FORMAT_GUIDANCE,
  'Include any settled-plan or constraint change and anything worth the supervisor’s intervention in the relevant field.',
  '',
  'You do not need an opening preamble. Ask the user a question only when the execution brief does not let you continue; otherwise keep working and disclose. Never expose private chain-of-thought.',
].join('\n')

/**
 * The one soft reminder, delivered as next-step context through
 * `tools/post-execute`.
 *
 * It asks for the same short structure as the standing policy. The base text
 * is purely instructional; a caller may compose one
 * objective activity fact beside it. Neither path threatens denial, requests
 * user input, or asks for chain-of-thought.
 */
export const DISCLOSURE_REMINDER_TEXT = [
  '[disclosure] Before continuing this stretch of tool work, send a concise structured disclosure of recent work, the next action, and the approach, including anything worth the supervisor’s intervention.',
  DISCLOSURE_FORMAT_GUIDANCE,
  'Then keep working autonomously whenever the execution brief lets you continue; do not wait for a reply unless you cannot proceed.',
].join('\n')

/**
 * The one sentence that distinguishes a later reminder in the same interval.
 *
 * It states the bounded runtime fact the plugin actually observed — this
 * interval is a repeat reminder and still carries no structured disclosure. That is
 * verifiable and is information the model does not reliably have about itself,
 * which is what a repeat buys. "Repeat" labels the message, not the model's
 * conduct, so it stays true without accusing anyone.
 *
 * It deliberately does not count reminders or mention a budget: telling the
 * model how many notices remain would let it wait the cadence out and turn the
 * disclosure policy into a game.
 */
export const DISCLOSURE_REPEAT_TEXT = 'This is a repeat reminder: no complete structured disclosure has been observed in this stretch.'

/**
 * The reminder text for one budget slot: the first reminder in an interval is
 * {@link DISCLOSURE_REMINDER_TEXT} verbatim, and every later one appends
 * {@link DISCLOSURE_REPEAT_TEXT} without changing the request.
 */
export function reminderTextFor(index: number, activityFact: string | null = null): string {
  const parts = [DISCLOSURE_REMINDER_TEXT]
  if (activityFact !== null) parts.push(activityFact)
  if (index > 0) parts.push(DISCLOSURE_REPEAT_TEXT)
  return parts.join(' ')
}
