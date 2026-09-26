import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyToolActivity,
  countCompletedCall,
  createActivity,
  createSilence,
  DEFAULT_CONFIG,
  DISCLOSURE_PLUGIN_NAME,
  DISCLOSURE_POLICY_TEXT,
  DISCLOSURE_REMINDER_TEXT,
  DISCLOSURE_REPEAT_TEXT,
  DISCLOSURE_TOOL_DESCRIPTION,
  DISCLOSURE_TOOL_NAME,
  hasVisibleText,
  inspectionActivityFact,
  isModelDisclosure,
  markReminderDelivered,
  reminderTextFor,
  recordActivity,
  resetActivity,
  resetSilence,
  resolveConfig,
  withReminder,
} from '../lib/policy.js'

test('defaults and zero-disable semantics remain stable', () => {
  const defaults = { reminderAfterCalls: 8, maxReminders: 3, activityWindowSize: 16, inspectionHintMinInspections: 8 }
  assert.deepEqual(DEFAULT_CONFIG, defaults)
  assert.deepEqual(resolveConfig(), defaults)
  assert.deepEqual(resolveConfig({ reminderAfterCalls: 0 }), { ...defaults, reminderAfterCalls: 0 })
  assert.deepEqual(resolveConfig({ maxReminders: 0 }), { ...defaults, maxReminders: 0 })
})

test('invalid numeric configuration fails closed', () => {
  for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '8']) {
    assert.throws(() => resolveConfig({ reminderAfterCalls: invalid }), /reminderAfterCalls/)
    assert.throws(() => resolveConfig({ maxReminders: invalid }), /maxReminders/)
  }
  for (const invalid of [null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '8']) {
    assert.throws(() => resolveConfig({ activityWindowSize: invalid }), /activityWindowSize/)
    assert.throws(() => resolveConfig({ inspectionHintMinInspections: invalid }), /inspectionHintMinInspections/)
  }
  assert.throws(() => resolveConfig({ inspectionHintMinInspections: 0 }), /inspectionHintMinInspections/)
  assert.throws(() => resolveConfig({ activityWindowSize: 4 }), /inspectionHintMinInspections.*activityWindowSize/)
})

test('the progress primitive and reminders have a tight fixed-context budget', () => {
  assert.equal(DISCLOSURE_PLUGIN_NAME, 'disclosure-policy')
  assert.equal(DISCLOSURE_TOOL_NAME, 'disclose_progress')
  assert.ok(DISCLOSURE_TOOL_DESCRIPTION.length < 120)
  assert.ok(DISCLOSURE_POLICY_TEXT.length < 140)
  assert.ok(DISCLOSURE_REMINDER_TEXT.length < 130)
  assert.ok(DISCLOSURE_REPEAT_TEXT.length < 100)
  assert.match(DISCLOSURE_TOOL_DESCRIPTION, /done, next, approach/)
  assert.match(DISCLOSURE_TOOL_DESCRIPTION, /alongside the next work tool/)
  assert.match(DISCLOSURE_REMINDER_TEXT, /disclose_progress/)
  assert.match(DISCLOSURE_REMINDER_TEXT, /batch it with the next work tool/)
  assert.doesNotMatch(DISCLOSURE_REMINDER_TEXT, /four|line|format|schema|reasoning|chain-of-thought/i)
})

test('tool activity classification stays coarse and conservative', () => {
  for (const name of ['read', 'read_file', 'grep', 'search_code', 'git_diff']) {
    assert.equal(classifyToolActivity(name), 'inspect', name)
  }
  for (const name of ['edit', 'apply_patch', 'update_file', 'create_blob']) {
    assert.equal(classifyToolActivity(name), 'mutate', name)
  }
  for (const name of ['pytest', 'npm_test', 'typecheck', 'acceptance_check']) {
    assert.equal(classifyToolActivity(name), 'verify', name)
  }
  for (const name of ['bash', 'run_code', 'shell', DISCLOSURE_TOOL_NAME]) {
    assert.equal(classifyToolActivity(name), 'other', name)
  }
})

test('inspection activity yields a compact objective suffix', () => {
  const activity = createActivity()
  for (let i = 0; i < 8; i += 1) recordActivity(activity, 'inspect')
  assert.equal(
    inspectionActivityFact(activity, 8),
    'Recent window: 8/8 inspection/search, 0 mutation/verification by tool-name classification. If investigating further, name the unresolved fact.',
  )
  recordActivity(activity, 'mutate')
  assert.equal(inspectionActivityFact(activity, 8), null)
})

test('activity ring evicts old mutation and verification observations', () => {
  for (const kind of ['mutate', 'verify']) {
    const activity = createActivity(4)
    recordActivity(activity, kind)
    for (let i = 0; i < 3; i += 1) recordActivity(activity, 'inspect')
    assert.equal(inspectionActivityFact(activity, 3), null)
    recordActivity(activity, 'inspect')
    assert.match(inspectionActivityFact(activity, 3), /4\/4 inspection\/search/)
  }
})

test('other operations occupy the activity window without pretending to be inspection', () => {
  const activity = createActivity(4)
  recordActivity(activity, 'inspect')
  recordActivity(activity, 'inspect')
  recordActivity(activity, 'other')
  assert.match(inspectionActivityFact(activity, 2), /2\/3 inspection\/search/)
  recordActivity(activity, 'other')
  recordActivity(activity, 'other')
  assert.equal(inspectionActivityFact(activity, 2), null)

  resetActivity(activity)
  assert.deepEqual(activity.operations, [])
  assert.equal(activity.inspect, 0)
})

test('one interval spends reminder budget at the configured cadence', () => {
  const state = createSilence()
  const due = []
  for (let call = 1; call <= 32; call += 1) {
    const index = countCompletedCall(state, 8, 3)
    if (index !== null) markReminderDelivered(state, state.calls, index)
    due.push(index)
  }
  assert.deepEqual(due, [
    ...Array(7).fill(null),
    0, ...Array(7).fill(null),
    1, ...Array(7).fill(null),
    2, ...Array(8).fill(null),
  ])
})

test('resetSilence restores cadence and budget', () => {
  const state = createSilence()
  for (let call = 0; call < 8; call += 1) {
    const index = countCompletedCall(state, 8, 3)
    if (index !== null) markReminderDelivered(state, state.calls, index)
  }
  assert.deepEqual(state, { calls: 8, firstReminderAt: 8, delivered: 1 })
  resetSilence(state)
  assert.deepEqual(state, { calls: 0, firstReminderAt: null, delivered: 0 })
})

test('nested calls do not advance cadence', () => {
  const state = createSilence()
  for (let i = 0; i < 20; i += 1) {
    assert.equal(countCompletedCall(state, 1, 3, { nested: true }), null)
  }
  assert.equal(state.calls, 0)
})

test('zero threshold or empty budget disables reminders without disabling counting', () => {
  for (const config of [{ reminderAfterCalls: 0, maxReminders: 3 }, { reminderAfterCalls: 8, maxReminders: 0 }]) {
    const state = createSilence()
    for (let call = 0; call < 20; call += 1) {
      assert.equal(countCompletedCall(state, config.reminderAfterCalls, config.maxReminders), null)
    }
    assert.equal(state.calls, 20)
  }
})

test('reminder text composes activity and repeat facts without publishing counters', () => {
  const fact = 'Observed activity fact.'
  assert.equal(reminderTextFor(0, fact), `${DISCLOSURE_REMINDER_TEXT} ${fact}`)
  assert.equal(
    reminderTextFor(1, fact),
    `${DISCLOSURE_REMINDER_TEXT} ${fact} ${DISCLOSURE_REPEAT_TEXT}`,
  )
  assert.match(DISCLOSURE_REPEAT_TEXT, /no disclose_progress call/)
  assert.doesNotMatch(DISCLOSURE_REPEAT_TEXT, /\d|budget|remaining|second|third|last/i)
})

test('reminder composition preserves downstream decisions and contexts', () => {
  const mine = { id: 'mine' }
  const theirs = { id: 'theirs' }
  assert.deepEqual(
    withReminder({ kind: 'accept', value: 42, additionalContexts: [theirs] }, mine),
    { kind: 'accept', value: 42, additionalContexts: [mine, theirs] },
  )
  assert.deepEqual(
    withReminder({ kind: 'block', feedback: [{ type: 'text', text: 'no' }] }, mine),
    { kind: 'block', feedback: [{ type: 'text', text: 'no' }], additionalContexts: [mine] },
  )
})

test('legacy visible-text helpers remain compatible but are no longer the runtime protocol', () => {
  assert.equal(hasVisibleText([{ type: 'text', text: ' ok ' }]), true)
  assert.equal(hasVisibleText([{ type: 'reasoning', text: 'private' }]), false)

  const message = {
    role: 'assistant',
    source: { kind: 'model' },
    content: [{
      type: 'text',
      text: 'Disclosure:\nDone: Checked records.\nNext: Check mapping.\nApproach: Read the index.',
    }],
  }
  assert.equal(isModelDisclosure(message), true)
  assert.equal(isModelDisclosure({ ...message, content: [{ type: 'text', text: 'ordinary prose' }] }), false)
})
