import test from 'node:test'
import assert from 'node:assert/strict'
import {
  countCompletedCall,
  createSilence,
  DEFAULT_CONFIG,
  DISCLOSURE_PLUGIN_NAME,
  DISCLOSURE_POLICY_ORDER,
  DISCLOSURE_POLICY_SECTION_NAME,
  DISCLOSURE_POLICY_TEXT,
  DISCLOSURE_REMINDER_TEXT,
  DISCLOSURE_REPEAT_TEXT,
  hasVisibleText,
  isModelDisclosure,
  markReminderDelivered,
  reminderTextFor,
  resetSilence,
  resolveConfig,
  withReminder,
} from '../lib/policy.js'

test('the two options default to 8/3 and 0 disables reminders', () => {
  assert.deepEqual(resolveConfig(), { reminderAfterCalls: 8, maxReminders: 3 })
  assert.deepEqual(DEFAULT_CONFIG, { reminderAfterCalls: 8, maxReminders: 3 })
  assert.deepEqual(resolveConfig({ reminderAfterCalls: 0 }), { reminderAfterCalls: 0, maxReminders: 3 })
  assert.deepEqual(resolveConfig({ reminderAfterCalls: 3, maxReminders: 1 }), { reminderAfterCalls: 3, maxReminders: 1 })
  assert.deepEqual(resolveConfig({ maxReminders: 0 }), { reminderAfterCalls: 8, maxReminders: 0 })
})

test('a non-integer or negative option fails closed', () => {
  for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '8']) {
    assert.throws(() => resolveConfig({ reminderAfterCalls: invalid }), /reminderAfterCalls/)
    assert.throws(() => resolveConfig({ maxReminders: invalid }), /maxReminders/)
  }
})

test('visible text excludes reasoning, images, and whitespace-only text', () => {
  assert.equal(hasVisibleText([{ type: 'reasoning', text: 'private' }]), false)
  assert.equal(hasVisibleText([{ type: 'text', text: '   \n\t ' }]), false)
  assert.equal(hasVisibleText([{ type: 'image', mediaType: 'image/png' }]), false)
  assert.equal(hasVisibleText([]), false)
  assert.equal(hasVisibleText([{ type: 'reasoning', text: 'x' }, { type: 'text', text: ' ok ' }]), true)
})

test('only model-authored assistant text opens a silence interval', () => {
  const model = { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'Root cause found.' }] }
  assert.equal(isModelDisclosure(model), true)

  assert.equal(isModelDisclosure({ ...model, content: [{ type: 'reasoning', text: 'thinking' }] }), false)
  assert.equal(isModelDisclosure({ ...model, content: [{ type: 'text', text: '  ' }] }), false)
  assert.equal(
    isModelDisclosure({ role: 'user', source: { kind: 'plugin', plugin: 'other' }, content: [{ type: 'text', text: 'notice' }] }),
    false,
  )
  assert.equal(
    isModelDisclosure({ role: 'assistant', source: { kind: 'plugin', plugin: 'other' }, content: [{ type: 'text', text: 'notice' }] }),
    false,
  )
})

test('one interval spends its budget one reminder per cadence period, then goes quiet', () => {
  const state = createSilence()
  assert.deepEqual(state, { calls: 0, firstReminderAt: null, delivered: 0 })

  // Reminders are recorded where they can actually be delivered, so the pure
  // test drives the same two steps the adapter does.
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
  ], 'reminders land at calls 8, 16, and 24, and nowhere else')
  assert.equal(state.calls, 32, 'a reminder never resets the count')
  assert.equal(state.delivered, 3)
})

test('the budget is bounded by maxReminders and 1 restores the one-shot cadence', () => {
  const once = createSilence()
  const sent = []
  for (let call = 0; call < 40; call += 1) {
    const index = countCompletedCall(once, 8, 1)
    if (index !== null) {
      sent.push(index)
      markReminderDelivered(once, once.calls, index)
    }
  }
  assert.deepEqual(sent, [0], 'maxReminders 1 is the historical one-shot latch')
})

test('the first reminder is the base text and later ones add the repeat sentence', () => {
  assert.equal(reminderTextFor(0), DISCLOSURE_REMINDER_TEXT)
  assert.equal(reminderTextFor(1), `${DISCLOSURE_REMINDER_TEXT} ${DISCLOSURE_REPEAT_TEXT}`)
  assert.equal(reminderTextFor(2), `${DISCLOSURE_REMINDER_TEXT} ${DISCLOSURE_REPEAT_TEXT}`)
})

test('visible model text re-arms the reminder and its budget', () => {
  const state = createSilence()
  for (let call = 0; call < 8; call += 1) {
    const index = countCompletedCall(state, 8, 3)
    if (index !== null) markReminderDelivered(state, state.calls, index)
  }
  assert.deepEqual(state, { calls: 8, firstReminderAt: 8, delivered: 1 })

  resetSilence(state)
  assert.deepEqual(state, { calls: 0, firstReminderAt: null, delivered: 0 })

  for (let call = 0; call < 7; call += 1) assert.equal(countCompletedCall(state, 8, 3), null)
  assert.equal(countCompletedCall(state, 8, 3), 0)
})

test('nested calls inside a composite tool never count', () => {
  const state = createSilence()
  for (let call = 0; call < 50; call += 1) {
    assert.equal(countCompletedCall(state, 1, 3, { nested: true }), null)
  }
  assert.equal(state.calls, 0, 'nested calls do not advance the interval')
  assert.equal(countCompletedCall(state, 1, 3), 0)
})

test('a parallel step spends at most one budget slot', () => {
  const state = createSilence()
  const due = []
  for (let call = 0; call < 12; call += 1) {
    const index = countCompletedCall(state, 8, 3)
    if (index !== null) {
      due.push(index)
      markReminderDelivered(state, state.calls, index)
    }
  }
  assert.deepEqual(due, [0], 'the call that crosses a period is the only one that carries its reminder')
  assert.equal(state.calls, 12)
})

test('a zero threshold or an empty budget disables reminders without breaking counting', () => {
  for (const config of [{ reminderAfterCalls: 0, maxReminders: 3 }, { reminderAfterCalls: 8, maxReminders: 0 }]) {
    const state = createSilence()
    for (let call = 0; call < 20; call += 1) {
      assert.equal(countCompletedCall(state, config.reminderAfterCalls, config.maxReminders), null)
    }
    assert.equal(state.calls, 20)
  }
})

test('the reminder composes into a downstream decision and preserves it', () => {
  const mine = { id: 'mine' }
  const theirs = { id: 'theirs' }

  const accepted = withReminder({ kind: 'accept', content: [{ type: 'text', text: 'result' }] }, mine)
  assert.deepEqual(accepted, {
    kind: 'accept',
    content: [{ type: 'text', text: 'result' }],
    additionalContexts: [mine],
  })

  const withExisting = withReminder({ kind: 'accept', value: 42, additionalContexts: [theirs] }, mine)
  assert.deepEqual(withExisting, { kind: 'accept', value: 42, additionalContexts: [mine, theirs] })

  const blocked = withReminder({ kind: 'block', feedback: [{ type: 'text', text: 'no' }], additionalContexts: [theirs] }, mine)
  assert.deepEqual(blocked, {
    kind: 'block',
    feedback: [{ type: 'text', text: 'no' }],
    additionalContexts: [mine, theirs],
  })
})

test('the standing policy asks the three disclosure questions and rules out chain-of-thought', () => {
  assert.match(DISCLOSURE_POLICY_TEXT, /What is now confirmed\?/)
  assert.match(DISCLOSURE_POLICY_TEXT, /change the settled plan/)
  assert.match(DISCLOSURE_POLICY_TEXT, /What happens next/)
  assert.match(DISCLOSURE_POLICY_TEXT, /never expose private chain-of-thought/i)
  assert.doesNotMatch(DISCLOSURE_POLICY_TEXT, /think step[- ]by[- ]step|explain your reasoning|reasoning:/i)
})

test('the standing policy covers the material disclosure moments', () => {
  assert.match(DISCLOSURE_POLICY_TEXT, /confirming a finding/)
  assert.match(DISCLOSURE_POLICY_TEXT, /completing a meaningful phase/)
  assert.match(DISCLOSURE_POLICY_TEXT, /departing from a settled constraint/)
  assert.match(DISCLOSURE_POLICY_TEXT, /obtaining a verification result/)
  assert.match(DISCLOSURE_POLICY_TEXT, /blocker/)
  assert.match(DISCLOSURE_POLICY_TEXT, /long stretch of work/)
  assert.match(DISCLOSURE_POLICY_TEXT, /do not need an opening preamble/i)
  assert.match(DISCLOSURE_POLICY_TEXT, /question only when/i)
})

test('the reminder asks for brief disclosure and makes no claim or threat', () => {
  assert.match(DISCLOSURE_REMINDER_TEXT, /one or two/)
  assert.match(DISCLOSURE_REMINDER_TEXT, /what is now confirmed/)
  assert.match(DISCLOSURE_REMINDER_TEXT, /what happens next/)
  assert.doesNotMatch(DISCLOSURE_REMINDER_TEXT, /\?/, 'the reminder asks the user nothing')
  assert.doesNotMatch(DISCLOSURE_REMINDER_TEXT, /\d+\s+(ordinary\s+)?(tool\s+)?calls?/i)
  assert.doesNotMatch(DISCLOSURE_REMINDER_TEXT, /deny|denied|blocked|threshold|guard/i)
  assert.doesNotMatch(DISCLOSURE_REMINDER_TEXT, /reasoning|chain-of-thought/i)
})

test('the repeat sentence states one bounded fact and never the remaining budget', () => {
  // The repeat is allowed to report what the plugin observed — this interval
  // already got a reminder and still carries no visible model text — and the
  // first reminder stays the bare request.
  assert.equal(reminderTextFor(1).endsWith(DISCLOSURE_REPEAT_TEXT), true)
  assert.equal(reminderTextFor(0).endsWith(DISCLOSURE_REPEAT_TEXT), false)

  assert.doesNotMatch(DISCLOSURE_REPEAT_TEXT, /\?/, 'the repeat asks the user nothing')
  assert.doesNotMatch(DISCLOSURE_REPEAT_TEXT, /\d/, 'no counts, so no budget can be inferred')
  assert.doesNotMatch(DISCLOSURE_REPEAT_TEXT, /budget|remaining|more|second|third|left|last/i)
  assert.doesNotMatch(DISCLOSURE_REPEAT_TEXT, /deny|denied|blocked|threshold|guard|calls?/i)
  assert.doesNotMatch(DISCLOSURE_REPEAT_TEXT, /reasoning|chain-of-thought/i)
})

test('the disclosure section keeps its slot in the prompt order', () => {
  assert.equal(DISCLOSURE_POLICY_ORDER, 10150)
  assert.ok(DISCLOSURE_POLICY_ORDER > 10100, 'after the first-party Web-surface section')
  assert.ok(DISCLOSURE_POLICY_ORDER < 10200, 'before the deployment persona suffix')
  assert.equal(DISCLOSURE_POLICY_SECTION_NAME, 'plugin:disclosure-policy:policy')
  assert.equal(DISCLOSURE_PLUGIN_NAME, 'disclosure-policy')
})
