import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyToolActivity,
  countCompletedCall,
  createActivity,
  createSilence,
  DEFAULT_CONFIG,
  DISCLOSURE_PLUGIN_NAME,
  DISCLOSURE_POLICY_ORDER,
  DISCLOSURE_POLICY_SECTION_NAME,
  DISCLOSURE_POLICY_TEXT,
  DISCLOSURE_REMINDER_TEXT,
  DISCLOSURE_REPEAT_TEXT,
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

test('activity settings default to 16/8 independently of reminder cadence and budget', () => {
  const defaults = { reminderAfterCalls: 8, maxReminders: 3, activityWindowSize: 16, inspectionHintMinInspections: 8 }
  assert.deepEqual(resolveConfig(), defaults)
  assert.deepEqual(DEFAULT_CONFIG, defaults)
  assert.deepEqual(resolveConfig({ reminderAfterCalls: 0 }), { ...defaults, reminderAfterCalls: 0 })
  assert.deepEqual(resolveConfig({ reminderAfterCalls: 3, maxReminders: 1 }), { ...defaults, reminderAfterCalls: 3, maxReminders: 1 })
  assert.deepEqual(resolveConfig({ maxReminders: 0 }), { ...defaults, maxReminders: 0 })
  assert.deepEqual(resolveConfig({ activityWindowSize: 4, inspectionHintMinInspections: 2 }), {
    ...defaults, activityWindowSize: 4, inspectionHintMinInspections: 2,
  })
})

test('a non-integer or negative option fails closed', () => {
  for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '8']) {
    assert.throws(() => resolveConfig({ reminderAfterCalls: invalid }), /reminderAfterCalls/)
    assert.throws(() => resolveConfig({ maxReminders: invalid }), /maxReminders/)
  }
})


test('tool activity classification is coarse and conservative', () => {
  for (const name of ['read', 'read_file', 'grep', 'search_code', 'git_diff']) {
    assert.equal(classifyToolActivity(name), 'inspect', name)
  }
  for (const name of ['edit', 'apply_patch', 'update_file', 'create_blob']) {
    assert.equal(classifyToolActivity(name), 'mutate', name)
  }
  for (const name of ['pytest', 'npm_test', 'typecheck', 'acceptance_check']) {
    assert.equal(classifyToolActivity(name), 'verify', name)
  }
  for (const name of ['bash', 'run_code', 'shell']) {
    assert.equal(classifyToolActivity(name), 'other', name)
  }
})

test('inspection-only activity yields an objective reminder fact at the configured scale', () => {
  const activity = createActivity()
  for (let i = 0; i < 8; i += 1) recordActivity(activity, 'inspect')

  const fact = inspectionActivityFact(activity, 8)
  assert.match(fact, /8 inspection\/search tool operations/)
  assert.match(fact, /no mutation-oriented or verification-oriented/)
  assert.match(fact, /unresolved fact/)

  recordActivity(activity, 'mutate')
  assert.equal(inspectionActivityFact(activity, 8), null)

  resetActivity(activity)
  for (let i = 0; i < 7; i += 1) recordActivity(activity, 'inspect')
  assert.equal(inspectionActivityFact(activity, 8), null)
})

test('an activity fact contextualizes the reminder without changing the base cadence text', () => {
  const fact = 'Observed activity fact.'
  assert.equal(reminderTextFor(0, fact), `${DISCLOSURE_REMINDER_TEXT} ${fact}`)
  assert.equal(
    reminderTextFor(1, fact),
    `${DISCLOSURE_REMINDER_TEXT} ${fact} ${DISCLOSURE_REPEAT_TEXT}`,
  )
})

test('visible text excludes reasoning, images, and whitespace-only text', () => {
  assert.equal(hasVisibleText([{ type: 'reasoning', text: 'private' }]), false)
  assert.equal(hasVisibleText([{ type: 'text', text: '   \n\t ' }]), false)
  assert.equal(hasVisibleText([{ type: 'image', mediaType: 'image/png' }]), false)
  assert.equal(hasVisibleText([]), false)
  assert.equal(hasVisibleText([{ type: 'reasoning', text: 'x' }, { type: 'text', text: ' ok ' }]), true)
})

test('only model-authored structured disclosure opens a disclosure interval', () => {
  const model = {
    role: 'assistant', source: { kind: 'model' },
    content: [{ type: 'text', text: 'Disclosure:\nDone: Found the missing skip filter.\nNext: Fix the top-level entry.\nApproach: Reuse the filter and verify a proceed sample.' }],
  }
  assert.equal(isModelDisclosure(model), true)
  assert.equal(isModelDisclosure({ ...model, content: [{ type: 'text', text: 'Now the driver — the row loop and branch enumeration:' }] }), false)
  assert.equal(isModelDisclosure({ ...model, role: 'user' }), false)
  assert.equal(isModelDisclosure({ ...model, source: { kind: 'disclosure-policy' } }), false)

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

test('invalid activity configuration is rejected instead of making hints unreachable', () => {
  for (const invalid of [null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '8']) {
    assert.throws(() => resolveConfig({ activityWindowSize: invalid }), /activityWindowSize/)
    assert.throws(() => resolveConfig({ inspectionHintMinInspections: invalid }), /inspectionHintMinInspections/)
  }
  assert.throws(() => resolveConfig({ inspectionHintMinInspections: 0 }), /inspectionHintMinInspections/)
  assert.throws(() => resolveConfig({ activityWindowSize: 4 }), /inspectionHintMinInspections.*activityWindowSize/)
  assert.equal(resolveConfig({ activityWindowSize: 0 }).inspectionHintMinInspections, 8)
  assert.throws(() => resolveConfig({ activityWindowSize: 0, inspectionHintMinInspections: 0 }), /inspectionHintMinInspections/)
  assert.throws(() => createActivity(-1), /activityWindowSize/)
})

test('an old edit or test leaves the activity window after sixteen later inspections', () => {
  for (const kind of ['mutate', 'verify']) {
    const activity = createActivity()
    recordActivity(activity, kind)
    for (let i = 0; i < 15; i += 1) recordActivity(activity, 'inspect')
    assert.equal(inspectionActivityFact(activity, 8), null)
    recordActivity(activity, 'inspect')
    assert.equal(
      inspectionActivityFact(activity, 8),
      'The last 16 observed tool operations included 16 inspection/search tool operations and no mutation-oriented or verification-oriented tool operations by tool-name classification. If more investigation is still needed, identify the unresolved fact it is intended to settle.',
    )
  }
})

test('other operations expire old inspections and a disabled window cannot qualify', () => {
  const activity = createActivity(4)
  for (let i = 0; i < 2; i += 1) recordActivity(activity, 'inspect')
  assert.match(inspectionActivityFact(activity, 2), /last 2 observed tool operations included 2 inspection/)
  for (let i = 0; i < 2; i += 1) recordActivity(activity, 'other')
  assert.match(inspectionActivityFact(activity, 2), /last 4 observed tool operations included 2 inspection/)
  recordActivity(activity, 'other')
  assert.equal(inspectionActivityFact(activity, 2), null)
  resetActivity(activity)
  recordActivity(activity, 'inspect')
  recordActivity(activity, 'inspect')
  assert.match(inspectionActivityFact(activity, 2), /last 2 observed tool operations included 2 inspection/)
  const disabled = createActivity(0)
  for (let i = 0; i < 20; i += 1) recordActivity(disabled, 'inspect')
  assert.equal(inspectionActivityFact(disabled, 1), null)
})

test('Chinese disclosure and honest opening or blocked disclosures satisfy the expression contract', () => {
  for (const text of [
    '披露：\n已做：对照了记录，尚未定位差异。\n将做：确认索引映射。\n做法：逐项比较原始索引与回放索引。',
    ' \r\n披露:\r\n已做: 尚未开始执行。\r\n将做: 检查枚举入口。\r\n做法: 对照入口与 skip 样例。\r\n ',
    'Disclosure:\nDone: Verification failed because credentials are missing.\nNext: Wait for credentials.\nApproach: Rerun the same verification when credentials are available.',
    '披露：\n已做：继续调查了。\n将做：继续调查。\n做法：继续查看。',
  ]) {
    const message = { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] }
    assert.equal(isModelDisclosure(message), true, text)
    assert.equal(isModelDisclosure(message), true, 'unchanged content remains eligible; there is no novelty test')
  }
})

test('recognition reads the entire visible text while excluding reasoning and tool-call blocks', () => {
  const message = {
    role: 'assistant', source: { kind: 'model' },
    content: [
      { type: 'reasoning', text: 'private' },
      { type: 'text', text: 'Disclosure:\nDone: Found the missing ' },
      { type: 'text', text: 'filter.\nNext: Fix the entry.\nApproach: Run a proceed regression.' },
      { type: 'tool-call', name: 'apply_patch' },
    ],
  }
  assert.equal(isModelDisclosure(message), true)
  assert.equal(isModelDisclosure({ ...message, content: [...message.content, { type: 'text', text: '\nOther prose.' }] }), false)
})

test('incomplete, mixed, quoted, fenced, or embedded structures are not disclosure', () => {
  const valid = 'Disclosure:\nDone: Found the filter gap.\nNext: Fix the entry.\nApproach: Run a regression.'
  for (const text of [
    'ok', 'Root cause found.',
    'Disclosure:\nDone: Found the filter gap.\nNext: Fix the entry.',
    'Disclosure:\nDone:  \nNext: Fix the entry.\nApproach: Run a regression.',
    'Disclosure:\nDone: Found the filter gap.\nNext: \t\nApproach: Run a regression.',
    'Disclosure:\nDone: Found the filter gap.\nNext: Fix the entry.\nApproach: ',
    'Disclosure:\nDone: Found the filter gap.\n将做：Fix the entry.\nApproach: Run a regression.',
    'Disclosure:\nNext: Fix the entry.\nDone: Found the filter gap.\nApproach: Run a regression.',
    'Disclosure: Example\nDone: Found the filter gap.\nNext: Fix the entry.\nApproach: Run a regression.',
    `\`\`\`text\n${valid}\n\`\`\``,
    valid.split('\n').map(line => `> ${line}`).join('\n'),
    `Here is an example:\n${valid}`, `${valid}\nAnd now more prose.`,
  ]) {
    assert.equal(isModelDisclosure({ role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] }), false, text)
  }
})

test('Markdown indented code blocks cannot impersonate direct disclosure', () => {
  const disclosure = 'Disclosure:\nDone: Checked records.\nNext: Compare mappings.\nApproach: Read both lists.'
  for (const indentation of ['    ', '\t', '  \t']) {
    const text = '\n' + disclosure.split('\n').map(line => indentation + line).join('\n') + '\n'
    assert.equal(isModelDisclosure({ role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] }), false, indentation)
  }
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

test('opening a disclosure interval re-arms the reminder and its budget', () => {
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

test('the standing policy specifies recent work, next action, and approach without requesting private reasoning', () => {
  assert.match(DISCLOSURE_POLICY_TEXT, /exactly four visible lines/)
  assert.match(DISCLOSURE_POLICY_TEXT, /Done: <recent work and its result or remaining uncertainty>/)
  assert.match(DISCLOSURE_POLICY_TEXT, /Next: <immediate intended action>/)
  assert.match(DISCLOSURE_POLICY_TEXT, /Approach: <concrete operations or verification>/)
  assert.match(DISCLOSURE_POLICY_TEXT, /披露：.*已做：.*将做：.*做法：/)
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
  assert.match(DISCLOSURE_REMINDER_TEXT, /exactly four visible lines/)
  assert.match(DISCLOSURE_REMINDER_TEXT, /Done:/)
  assert.match(DISCLOSURE_REMINDER_TEXT, /Next:/)
  assert.match(DISCLOSURE_REMINDER_TEXT, /Approach:/)
  assert.doesNotMatch(DISCLOSURE_REMINDER_TEXT, /\?/, 'the reminder asks the user nothing')
  assert.doesNotMatch(DISCLOSURE_REMINDER_TEXT, /\d+\s+(ordinary\s+)?(tool\s+)?calls?/i)
  assert.doesNotMatch(DISCLOSURE_REMINDER_TEXT, /deny|denied|blocked|threshold|guard/i)
  assert.doesNotMatch(DISCLOSURE_REMINDER_TEXT, /reasoning|chain-of-thought/i)
})

test('the repeat sentence states one bounded fact and never the remaining budget', () => {
  // The repeat is allowed to report what the plugin observed — this interval
  // already got a reminder and still carries no structured disclosure — and the
  // first reminder stays the bare request.
  assert.equal(reminderTextFor(1).endsWith(DISCLOSURE_REPEAT_TEXT), true)
  assert.equal(reminderTextFor(0).endsWith(DISCLOSURE_REPEAT_TEXT), false)
  assert.match(DISCLOSURE_REPEAT_TEXT, /no complete structured disclosure/)

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
