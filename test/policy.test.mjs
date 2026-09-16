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
  hasVisibleText,
  isModelDisclosure,
  resetSilence,
  resolveConfig,
  withReminder,
} from '../lib/policy.js'

test('the only option defaults to 8 and 0 disables reminders', () => {
  assert.deepEqual(resolveConfig(), { reminderAfterCalls: 8 })
  assert.deepEqual(DEFAULT_CONFIG, { reminderAfterCalls: 8 })
  assert.deepEqual(resolveConfig({ reminderAfterCalls: 0 }), { reminderAfterCalls: 0 })
  assert.deepEqual(resolveConfig({ reminderAfterCalls: 3 }), { reminderAfterCalls: 3 })
})

test('a non-integer or negative threshold fails closed', () => {
  for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '8']) {
    assert.throws(() => resolveConfig({ reminderAfterCalls: invalid }), /reminderAfterCalls/)
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

test('one silence interval is reminded exactly once at the threshold', () => {
  const state = createSilence()
  assert.deepEqual(state, { calls: 0, reminded: false })

  for (let call = 1; call < 8; call += 1) {
    assert.equal(countCompletedCall(state, 8), false, `call ${call}`)
  }
  assert.equal(state.calls, 7)
  assert.equal(state.reminded, false)

  assert.equal(countCompletedCall(state, 8), true)
  assert.equal(state.calls, 8, 'the reminder does not reset the count')
  assert.equal(state.reminded, true)

  for (let call = 9; call <= 20; call += 1) {
    assert.equal(countCompletedCall(state, 8), false, `call ${call}`)
  }
  assert.equal(state.calls, 20)
})

test('visible model text opens a new interval and re-arms the reminder', () => {
  const state = createSilence()
  for (let call = 0; call < 8; call += 1) countCompletedCall(state, 8)
  assert.equal(state.reminded, true)

  resetSilence(state)
  assert.deepEqual(state, { calls: 0, reminded: false })

  for (let call = 0; call < 7; call += 1) assert.equal(countCompletedCall(state, 8), false)
  assert.equal(countCompletedCall(state, 8), true)
})

test('nested calls inside a composite tool never count', () => {
  const state = createSilence()
  for (let call = 0; call < 50; call += 1) {
    assert.equal(countCompletedCall(state, 1, { nested: true }), false)
  }
  assert.equal(state.calls, 0, 'nested calls do not advance the interval')
  assert.equal(countCompletedCall(state, 1), true)
})

test('a parallel step yields at most one reminder', () => {
  const state = createSilence()
  let reminders = 0
  for (let call = 0; call < 12; call += 1) {
    if (countCompletedCall(state, 8)) reminders += 1
  }
  assert.equal(reminders, 1)
  assert.equal(state.calls, 12)
})

test('a zero threshold disables reminders without breaking counting', () => {
  const state = createSilence()
  for (let call = 0; call < 9; call += 1) {
    assert.equal(countCompletedCall(state, 0), false)
  }
  assert.equal(state.calls, 9)
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
  assert.match(DISCLOSURE_POLICY_TEXT, /question only when/i)
})

test('the reminder asks for brief disclosure and makes no runtime claim or threat', () => {
  assert.match(DISCLOSURE_REMINDER_TEXT, /one or two/)
  assert.match(DISCLOSURE_REMINDER_TEXT, /what is now confirmed/)
  assert.match(DISCLOSURE_REMINDER_TEXT, /what happens next/)
  assert.doesNotMatch(DISCLOSURE_REMINDER_TEXT, /\?/, 'the reminder asks the user nothing')
  assert.doesNotMatch(DISCLOSURE_REMINDER_TEXT, /\d+\s+(ordinary\s+)?(tool\s+)?calls?/i)
  assert.doesNotMatch(DISCLOSURE_REMINDER_TEXT, /deny|denied|blocked|threshold|guard/i)
  assert.doesNotMatch(DISCLOSURE_REMINDER_TEXT, /reasoning|chain-of-thought/i)
})

test('the disclosure section keeps its slot in the prompt order', () => {
  assert.equal(DISCLOSURE_POLICY_ORDER, 10150)
  assert.ok(DISCLOSURE_POLICY_ORDER > 10100, 'after the first-party Web-surface section')
  assert.ok(DISCLOSURE_POLICY_ORDER < 10200, 'before the deployment persona suffix')
  assert.equal(DISCLOSURE_POLICY_SECTION_NAME, 'plugin:disclosure-policy:policy')
  assert.equal(DISCLOSURE_PLUGIN_NAME, 'disclosure-policy')
})
