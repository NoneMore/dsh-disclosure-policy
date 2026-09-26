import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DISCLOSURE_POLICY_ORDER,
  DISCLOSURE_POLICY_SECTION_NAME,
  DISCLOSURE_POLICY_TEXT,
  reminderTextFor,
} from '../lib/policy.js'

// The host dependency graph is a devDependency of this repository, not a
// prerequisite for the pure policy suite. When it is absent, the behavior tests
// below are skipped with an explicit reason instead of failing the suite.
let host
let unavailable
try {
  host = await import('../lib/index.js')
} catch (error) {
  unavailable = `host dependency graph unavailable (${error?.code ?? error?.message})`
}

const skip = unavailable === undefined ? false : unavailable

function createHarness(options = {}) {
  const listeners = new Map()
  const disposers = []
  const sections = []
  const guards = []

  const systemPrompt = options.systemPrompt === false
    ? undefined
    : {
        section(section) {
          sections.push(section)
          return () => {}
        },
      }

  const ctx = {
    on(name, listener) {
      const registered = listeners.get(name) ?? []
      registered.push(listener)
      listeners.set(name, registered)
      return () => {}
    },
    get(name) {
      return name === 'systemPrompt' ? systemPrompt : undefined
    },
    effect(callback) {
      disposers.push(callback())
    },
    tools: {
      guard(guard) {
        guards.push(guard)
        return () => {}
      },
    },
  }

  return {
    ctx,
    sections,
    guards,
    disposers,
    eventNames: () => [...listeners.keys()],
    emit(session, event) {
      for (const listener of listeners.get('session/event') ?? []) listener(session, event)
    },
    async postExecute(session, downstream = { kind: 'accept' }, exec = {}, options = {}) {
      const execution = { name: 'bash', agent: { session }, ...exec }
      const result = options.result ?? { isError: false, content: [], value: null }
      const registered = listeners.get('tools/post-execute') ?? []
      assert.equal(registered.length, 1, 'exactly one post-execute listener')
      return await registered[0](execution, result, async () => {
        if (options.waitFor !== undefined) await options.waitFor
        if (options.delayMs !== undefined) await new Promise(resolve => setTimeout(resolve, options.delayMs))
        if (options.downstreamError !== undefined) throw options.downstreamError
        return downstream
      })
    },
  }
}

const TURN = {
  start: (turn) => ({ type: 'turn/start', data: { turn } }),
  end: (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }),
}

function modelMessage(content) {
  return {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content } },
  }
}

function pluginMessage() {
  return {
    type: 'user/message',
    data: {
      role: 'user',
      source: { kind: 'other-plugin', form: 'notice', summary: 'notice' },
      content: [{ type: 'text', text: 'plugin-authored notice' }],
    },
  }
}

function pluginAuthoredAssistantMessage() {
  return {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        source: { kind: 'other-plugin', form: 'notice', summary: 'notice' },
        content: [{ type: 'text', text: 'a plugin-authored assistant row' }],
      },
    },
  }
}

function reminders(decision) {
  return (decision.additionalContexts ?? []).filter(message => message?.source?.kind === 'disclosure-policy')
}

function assertNoticeShape(decision, index = 0, activityFact = null) {
  const found = reminders(decision)
  assert.equal(found.length, 1)
  const [notice] = found
  assert.equal(notice.role, 'user')
  assert.equal(notice.source.kind, 'disclosure-policy')
  assert.equal(notice.source.form, 'notice')
  assert.equal(typeof notice.source.summary, 'string')
  assert.equal(notice.source.summary.length <= 120, true)
  assert.deepEqual(notice.content, [{ type: 'text', text: reminderTextFor(index, activityFact) }])
  return notice
}

test('the plugin listens to exactly the two sanctioned extension points', { skip }, () => {
  const harness = createHarness()
  host.apply(harness.ctx, { reminderAfterCalls: 8 })

  assert.deepEqual(harness.eventNames().sort(), ['session/event', 'tools/post-execute'])
  assert.equal(harness.guards.length, 0, 'no ctx.tools.guard() registration')
  assert.equal(harness.sections.length, 1)
  assert.equal(harness.sections[0].name, DISCLOSURE_POLICY_SECTION_NAME)
  assert.equal(harness.sections[0].order, DISCLOSURE_POLICY_ORDER)
  assert.equal(harness.sections[0].text, DISCLOSURE_POLICY_TEXT)
  assert.equal(harness.disposers.length, 1, 'the prompt section is owned by the plugin fiber')
})

test('the configured cadence yields a repeat reminder per period up to the budget', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'session-1' }
  host.apply(harness.ctx, { reminderAfterCalls: 8, maxReminders: 3 })
  harness.emit(session, TURN.start(1))

  const carriers = []
  for (let call = 1; call <= 32; call += 1) {
    const decision = await harness.postExecute(session)
    const found = reminders(decision)
    if (found.length === 0) {
      assert.equal(decision.additionalContexts, undefined, `call ${call} stays untouched`)
    } else {
      carriers.push(call)
      assertNoticeShape(decision, carriers.length - 1)
    }
  }

  assert.deepEqual(carriers, [8, 16, 24], 'three notices, one per cadence period')
})

test('structured model disclosure re-arms the interval while reasoning and plugin messages do not', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'session-2' }
  host.apply(harness.ctx, { reminderAfterCalls: 3, maxReminders: 2 })
  harness.emit(session, TURN.start(1))

  harness.emit(session, modelMessage([{ type: 'reasoning', text: 'private reasoning only' }]))
  harness.emit(session, pluginMessage())
  harness.emit(session, pluginAuthoredAssistantMessage())
  for (let call = 0; call < 3; call += 1) {
    const decision = await harness.postExecute(session)
    if (call < 2) assert.equal(decision.additionalContexts, undefined, `silent call ${call}`)
    else assertNoticeShape(decision, 0)
  }

  harness.emit(session, modelMessage([{ type: 'reasoning', text: 'more private reasoning' }]))
  assert.equal((await harness.postExecute(session)).additionalContexts, undefined, 'call 4 is between periods')
  assert.equal((await harness.postExecute(session)).additionalContexts, undefined, 'call 5 is between periods')
  assertNoticeShape(await harness.postExecute(session), 1)
  for (let call = 0; call < 6; call += 1) {
    const decision = await harness.postExecute(session)
    assert.equal(decision.additionalContexts, undefined, `budget spent, still one interval, call ${call}`)
  }

  harness.emit(session, modelMessage([{ type: 'text', text: 'Disclosure:\nDone: Confirmed the filter gap.\nNext: Fix the entry.\nApproach: Run a proceed regression.' }]))
  await harness.postExecute(session)
  await harness.postExecute(session)
  assertNoticeShape(await harness.postExecute(session), 0)
})

test('only complete disclosure resets cadence and budget, including repeated disclosure', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'session-structured-disclosure' }
  host.apply(harness.ctx, { reminderAfterCalls: 3, maxReminders: 2, activityWindowSize: 0 })
  harness.emit(session, TURN.start(1))

  const read = () => harness.postExecute(session, { kind: 'accept' }, { name: 'read' })
  await harness.postExecute(session, { kind: 'accept' }, { name: 'edit' })
  harness.emit(session, modelMessage([{ type: 'text', text: 'Now the replay check in choose_nested:' }]))
  harness.emit(session, modelMessage([{ type: 'text', text: '    Disclosure:\n    Done: Checked records.\n    Next: Compare mappings.\n    Approach: Read both lists.' }]))
  assert.equal((await read()).additionalContexts, undefined, 'ordinary prose does not reset or send an early reminder')
  harness.emit(session, modelMessage([{ type: 'text', text: 'Disclosure:\nDone: Checked replay.\nNext: Inspect the index.' }]))
  assertNoticeShape(await read(), 0, null)

  harness.emit(session, modelMessage([{ type: 'text', text: 'Continuing the investigation.' }]))
  await read()
  await read()
  assertNoticeShape(await read(), 1, null)
  harness.emit(session, modelMessage([{ type: 'text', text: 'ok' }]))
  for (let call = 0; call < 3; call += 1) {
    assert.equal((await read()).additionalContexts, undefined, 'ordinary prose cannot restore an exhausted budget')
  }

  const disclosure = modelMessage([
    { type: 'text', text: '披露：\n已做：对照了回放记录，索引差异仍待确认。\n将做：检查奖励映射。\n做法：逐项比较原始索引与选择索引。' },
    { type: 'tool-call', name: 'read' },
  ])
  for (let interval = 0; interval < 2; interval += 1) {
    harness.emit(session, disclosure)
    assert.equal((await read()).additionalContexts, undefined)
    assert.equal((await read()).additionalContexts, undefined)
    assertNoticeShape(await read(), 0)
    await read()
    await read()
    assertNoticeShape(await read(), 1)
  }
})


test('an inspection-only stretch adds objective activity context to the normal reminder', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'session-activity-inspect' }
  host.apply(harness.ctx, { reminderAfterCalls: 3, maxReminders: 1, inspectionHintMinInspections: 3 })
  harness.emit(session, TURN.start(1))

  await harness.postExecute(session, { kind: 'accept' }, { name: 'read' })
  await harness.postExecute(session, { kind: 'accept' }, { name: 'grep' })
  const fact = 'The last 3 observed tool operations included 3 inspection/search tool operations and no mutation-oriented or verification-oriented tool operations by tool-name classification. If more investigation is still needed, identify the unresolved fact it is intended to settle.'
  assertNoticeShape(
    await harness.postExecute(session, { kind: 'accept' }, { name: 'search_code' }),
    0,
    fact,
  )
})

test('nested native inspections enrich activity without advancing the disclosure cadence', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'session-activity-nested' }
  host.apply(harness.ctx, { reminderAfterCalls: 2, maxReminders: 1, inspectionHintMinInspections: 5 })
  harness.emit(session, TURN.start(1))

  for (let call = 0; call < 5; call += 1) {
    const decision = await harness.postExecute(
      session,
      { kind: 'accept' },
      { name: 'read', parent: Symbol('run_code') },
    )
    assert.equal(decision.additionalContexts, undefined)
  }

  assert.equal((await harness.postExecute(session, { kind: 'accept' }, { name: 'run_code' })).additionalContexts, undefined)
  const fact = 'The last 7 observed tool operations included 5 inspection/search tool operations and no mutation-oriented or verification-oriented tool operations by tool-name classification. If more investigation is still needed, identify the unresolved fact it is intended to settle.'
  assertNoticeShape(
    await harness.postExecute(session, { kind: 'accept' }, { name: 'run_code' }),
    0,
    fact,
  )
})

test('a mutation-oriented operation suppresses the inspection-only activity suffix', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'session-activity-mutate' }
  host.apply(harness.ctx, { reminderAfterCalls: 3, maxReminders: 1 })
  harness.emit(session, TURN.start(1))

  await harness.postExecute(session, { kind: 'accept' }, { name: 'read' })
  await harness.postExecute(session, { kind: 'accept' }, { name: 'edit' })
  assertNoticeShape(await harness.postExecute(session, { kind: 'accept' }, { name: 'grep' }))
})

test('disclosure preserves recent inspections while resetting reminder accounting', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'session-preserved-window' }
  host.apply(harness.ctx, { reminderAfterCalls: 1, maxReminders: 1, activityWindowSize: 4, inspectionHintMinInspections: 2 })
  harness.emit(session, TURN.start(1))
  for (let i = 0; i < 2; i += 1) {
    await harness.postExecute(session, { kind: 'accept' }, { name: 'read', parent: Symbol('run_code') })
  }
  const disclosure = modelMessage([{ type: 'text', text: 'Disclosure:\nDone: Compared records.\nNext: Check mapping.\nApproach: Read the index.' }])
  harness.emit(session, disclosure)
  const fact = 'The last 3 observed tool operations included 3 inspection/search tool operations and no mutation-oriented or verification-oriented tool operations by tool-name classification. If more investigation is still needed, identify the unresolved fact it is intended to settle.'
  assertNoticeShape(await harness.postExecute(session, { kind: 'accept' }, { name: 'read' }), 0, fact)
  assert.equal((await harness.postExecute(session, { kind: 'accept' }, { name: 'read' })).additionalContexts, undefined)
  harness.emit(session, disclosure)
  assertNoticeShape(await harness.postExecute(session, { kind: 'accept' }, { name: 'bash' }), 0,
    'The last 4 observed tool operations included 3 inspection/search tool operations and no mutation-oriented or verification-oriented tool operations by tool-name classification. If more investigation is still needed, identify the unresolved fact it is intended to settle.')
})

test('edit followed by thirty reads regains a hint within the original reminder budget', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'session-edit-thirty-reads' }
  host.apply(harness.ctx)
  harness.emit(session, TURN.start(1))
  await harness.postExecute(session, { kind: 'accept' }, { name: 'edit' })
  for (let read = 1; read <= 30; read += 1) {
    const decision = await harness.postExecute(session, { kind: 'accept' }, { name: 'search' })
    if (read === 7) assertNoticeShape(decision, 0)
    else if (read === 15) assertNoticeShape(decision, 1)
    else if (read === 23) assertNoticeShape(decision, 2,
      'The last 16 observed tool operations included 16 inspection/search tool operations and no mutation-oriented or verification-oriented tool operations by tool-name classification. If more investigation is still needed, identify the unresolved fact it is intended to settle.')
    else assert.equal(decision.additionalContexts, undefined, `read ${read} does not create an extra reminder`)
  }
})

test('a late parallel verification occupies the window until later observations evict it', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'session-observation-order' }
  host.apply(harness.ctx, { reminderAfterCalls: 4, maxReminders: 2, activityWindowSize: 3, inspectionHintMinInspections: 2 })
  harness.emit(session, TURN.start(1))
  const gate = Promise.withResolvers()
  const verification = harness.postExecute(session, { kind: 'accept' }, { name: 'test' }, { waitFor: gate.promise })
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await harness.postExecute(session, { kind: 'accept' }, { name: 'read' })).additionalContexts, undefined)
  }
  gate.resolve()
  assertNoticeShape(await verification, 0)
  harness.emit(session, modelMessage([{ type: 'text', text: 'Disclosure:\nDone: Test failed.\nNext: Inspect inputs.\nApproach: Read the records.' }]))
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await harness.postExecute(session, { kind: 'accept' }, { name: 'read' })).additionalContexts, undefined)
  }
  assertNoticeShape(await harness.postExecute(session, { kind: 'accept' }, { name: 'read' }), 0,
    'The last 3 observed tool operations included 3 inspection/search tool operations and no mutation-oriented or verification-oriented tool operations by tool-name classification. If more investigation is still needed, identify the unresolved fact it is intended to settle.')
})

test('activity settings are validated on mount and zero capacity disables hints alone', { skip }, async () => {
  assert.throws(() => host.apply(createHarness().ctx, { activityWindowSize: 4 }), /inspectionHintMinInspections.*activityWindowSize/)
  assert.throws(() => host.apply(createHarness().ctx, { activityWindowSize: null }), /activityWindowSize/)
  assert.throws(() => host.apply(createHarness().ctx, { inspectionHintMinInspections: null }), /inspectionHintMinInspections/)
  const harness = createHarness()
  const session = { id: 'session-disabled-hints' }
  host.apply(harness.ctx, { activityWindowSize: 0 })
  harness.emit(session, TURN.start(1))
  for (let call = 1; call <= 8; call += 1) {
    const decision = await harness.postExecute(session, { kind: 'accept' }, { name: 'read' })
    if (call === 8) assertNoticeShape(decision, 0)
    else assert.equal(decision.additionalContexts, undefined)
  }
})

test('a failed nested verification remains in the window across disclosure', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'session-failed-verification' }
  host.apply(harness.ctx, { reminderAfterCalls: 1, activityWindowSize: 4, inspectionHintMinInspections: 2 })
  harness.emit(session, TURN.start(1))
  const nested = { parent: Symbol('run_code') }
  for (let i = 0; i < 2; i += 1) await harness.postExecute(session, { kind: 'accept' }, { ...nested, name: 'read' })
  await harness.postExecute(session, { kind: 'accept' }, { ...nested, name: 'test' }, { result: { isError: true, content: [] } })
  harness.emit(session, modelMessage([{ type: 'text', text: 'Disclosure:\nDone: Test failed.\nNext: Check inputs.\nApproach: Read records.' }]))
  assertNoticeShape(await harness.postExecute(session, { kind: 'accept' }, { name: 'read' }), 0)
})

test('activity starts empty on a new turn and is not reconstructed on hot reload', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'session-window-lifecycle' }
  host.apply(harness.ctx, { reminderAfterCalls: 1, inspectionHintMinInspections: 2 })
  assert.equal((await harness.postExecute(session, { kind: 'accept' }, { name: 'read' })).additionalContexts, undefined)
  harness.emit(session, TURN.start(1))
  for (let i = 0; i < 2; i += 1) await harness.postExecute(session, { kind: 'accept' }, { name: 'read', parent: Symbol('run_code') })
  harness.emit(session, TURN.end(1))
  harness.emit(session, TURN.start(2))
  assertNoticeShape(await harness.postExecute(session, { kind: 'accept' }, { name: 'read' }), 0)
})

test('nested calls do not count and a parallel step produces at most one notice', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'session-3' }
  host.apply(harness.ctx, { reminderAfterCalls: 8 })
  harness.emit(session, TURN.start(1))

  for (let call = 0; call < 40; call += 1) {
    const decision = await harness.postExecute(session, { kind: 'accept' }, { parent: Symbol('run_code') })
    assert.equal(decision.additionalContexts, undefined, 'nested dispatch is not counted')
  }

  const decisions = await Promise.all(
    Array.from({ length: 12 }, (_, index) => harness.postExecute(session, { kind: 'accept' }, {}, {
      // Settle out of submission order, as a real parallel step does.
      delayMs: (12 - index) % 5,
    })),
  )
  assert.equal(
    decisions.filter(decision => reminders(decision).length > 0).length,
    1,
    'a parallel step crosses one cadence period, so at most one notice is delivered',
  )
})

test('failed, denied, and blocked outcomes all still count as completed calls', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'session-counting' }
  host.apply(harness.ctx, { reminderAfterCalls: 3 })
  harness.emit(session, TURN.start(1))

  const denied = { isError: true, content: [], error: { name: 'Denied', code: 'POLICY_DENIED' } }
  const failed = { isError: true, content: [], error: { name: 'Failure', code: 'TOOL_FAILED' } }
  const succeeded = { isError: false, content: [], value: null }

  assert.equal((await harness.postExecute(session, { kind: 'accept' }, {}, { result: denied })).additionalContexts, undefined)
  assert.equal((await harness.postExecute(session, { kind: 'accept' }, {}, { result: succeeded })).additionalContexts, undefined)
  assertNoticeShape(await harness.postExecute(session, { kind: 'block', feedback: [] }, {}, { result: failed }))
})

test('a throwing downstream policy still counts and defers the reminder until delivery is possible', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'session-throwing-policy' }
  host.apply(harness.ctx, { reminderAfterCalls: 2, maxReminders: 3 })
  harness.emit(session, TURN.start(1))

  await assert.rejects(
    harness.postExecute(session, undefined, {}, { downstreamError: new Error('downstream policy failed') }),
    /downstream policy failed/,
  )

  assertNoticeShape(await harness.postExecute(session))
})

test('a zero threshold or an empty budget keeps the standing policy and stops reminders', { skip }, async () => {
  for (const config of [
    { reminderAfterCalls: 0, maxReminders: 3 },
    { reminderAfterCalls: 8, maxReminders: 0 },
  ]) {
    const harness = createHarness()
    const session = { id: `session-${config.reminderAfterCalls}-${config.maxReminders}` }
    host.apply(harness.ctx, config)
    harness.emit(session, TURN.start(1))

    for (let call = 0; call < 50; call += 1) {
      const decision = await harness.postExecute(session)
      assert.equal(decision.additionalContexts, undefined)
    }

    assert.equal(harness.sections.length, 1)
    assert.equal(harness.sections[0].text, DISCLOSURE_POLICY_TEXT)
  }
})

test('turn/end discards the state and the next turn starts clean', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'session-5' }
  host.apply(harness.ctx, { reminderAfterCalls: 4, maxReminders: 3 })

  harness.emit(session, TURN.start(1))
  for (let call = 0; call < 4; call += 1) await harness.postExecute(session)
  harness.emit(session, TURN.end(1))

  for (let call = 0; call < 10; call += 1) {
    const decision = await harness.postExecute(session)
    assert.equal(decision.additionalContexts, undefined, 'a closed turn is not reminded')
  }

  harness.emit(session, TURN.start(2))
  for (let call = 0; call < 3; call += 1) {
    assert.equal((await harness.postExecute(session)).additionalContexts, undefined)
  }
  assertNoticeShape(await harness.postExecute(session))
})

test('a denied or blocked downstream decision keeps its shape and our context', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'session-6' }
  host.apply(harness.ctx, { reminderAfterCalls: 1, maxReminders: 1 })
  harness.emit(session, TURN.start(1))

  const theirs = { role: 'user', source: { kind: 'plugin', plugin: 'other' }, content: [{ type: 'text', text: 'theirs' }] }
  const feedback = [{ type: 'text', text: 'call denied' }]
  const decision = await harness.postExecute(
    session,
    { kind: 'block', feedback, additionalContexts: [theirs] },
  )

  assert.equal(decision.kind, 'block')
  assert.deepEqual(decision.feedback, feedback)
  assert.equal(decision.additionalContexts.length, 2)
  assertNoticeShape(decision)
  assert.equal(decision.additionalContexts[1], theirs)
})

test('an accepted downstream result keeps its content', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'session-7' }
  host.apply(harness.ctx, { reminderAfterCalls: 1, maxReminders: 1 })
  harness.emit(session, TURN.start(1))

  const content = [{ type: 'text', text: 'tool output' }]
  const decision = await harness.postExecute(session, { kind: 'accept', content })

  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content, content)
  assertNoticeShape(decision)
})

test('an absent systemPrompt service is tolerated', { skip }, async () => {
  const harness = createHarness({ systemPrompt: false })
  const session = { id: 'session-8' }
  host.apply(harness.ctx, { reminderAfterCalls: 2, maxReminders: 3 })
  harness.emit(session, TURN.start(1))

  assert.deepEqual(harness.eventNames().sort(), ['session/event', 'tools/post-execute'])
  await harness.postExecute(session)
  assertNoticeShape(await harness.postExecute(session))
})
