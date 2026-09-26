import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DISCLOSURE_TOOL_DESCRIPTION,
  DISCLOSURE_TOOL_NAME,
  reminderTextFor,
} from '../lib/policy.js'

let host
let unavailable
try {
  host = await import('../lib/index.js')
} catch (error) {
  unavailable = `host dependency graph unavailable (${error?.code ?? error?.message})`
}

const skip = unavailable === undefined ? false : unavailable

function createHarness() {
  const listeners = new Map()
  const guards = []
  const tools = new Map()

  const ctx = {
    on(name, listener) {
      const registered = listeners.get(name) ?? []
      registered.push(listener)
      listeners.set(name, registered)
      return () => {}
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      guard(guard) {
        guards.push(guard)
        return () => {}
      },
    },
  }

  return {
    ctx,
    guards,
    tools,
    eventNames: () => [...listeners.keys()],
    emit(session, event) {
      for (const listener of listeners.get('session/event') ?? []) listener(session, event)
    },
    async executeTool(session, name, args, exec = {}) {
      const tool = tools.get(name)
      assert.ok(tool, `registered tool ${name}`)
      return await tool.execute(args, {
        name,
        agent: { session },
        signal: new AbortController().signal,
        ...exec,
      })
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
  start: turn => ({ type: 'turn/start', data: { turn } }),
  end: turn => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }),
}

function assistantStep(step, content = []) {
  return {
    type: 'assistant/message',
    data: {
      turn: 1,
      step,
      message: { role: 'assistant', source: { kind: 'model' }, content },
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
  assert.equal(notice.source.summary, 'Progress checkpoint reminder')
  assert.deepEqual(notice.content, [{ type: 'text', text: reminderTextFor(index, activityFact) }])
  return notice
}

async function disclose(harness, session, args, exec = {}) {
  const value = await harness.executeTool(session, DISCLOSURE_TOOL_NAME, args, exec)
  assert.equal(value, null)
  const decision = await harness.postExecute(
    session,
    { kind: 'accept', content: [] },
    { name: DISCLOSURE_TOOL_NAME, ...exec },
  )
  assert.equal(decision.additionalContexts, undefined)
  return value
}

test('the plugin registers one compact progress tool and only two runtime listeners', { skip }, () => {
  const harness = createHarness()
  host.apply(harness.ctx, { reminderAfterCalls: 8 })

  assert.deepEqual(harness.eventNames().sort(), ['session/event', 'tools/post-execute'])
  assert.equal(harness.guards.length, 0)
  assert.deepEqual([...harness.tools.keys()], [DISCLOSURE_TOOL_NAME])

  const tool = harness.tools.get(DISCLOSURE_TOOL_NAME)
  assert.equal(tool.description, DISCLOSURE_TOOL_DESCRIPTION)
  assert.equal(tool.deferLoading, undefined)
  assert.equal(typeof tool.isConcurrencySafe, 'function')
  assert.equal(tool.isConcurrencySafe({ done: 'd', next: 'n', approach: 'a' }), true, 'valid progress calls must opt into parallel scheduling')
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['approach', 'done', 'next'])
  assert.deepEqual(tool.parameters.required.sort(), ['approach', 'done', 'next'])
  for (const parameter of Object.values(tool.parameters.properties)) {
    assert.equal(parameter.type, 'string')
    assert.equal(parameter.description, undefined)
  }
})

test('the fixed model-facing declaration stays deliberately small and result text is empty', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'context-budget' }
  host.apply(harness.ctx)
  harness.emit(session, TURN.start(1))

  const tool = harness.tools.get(DISCLOSURE_TOOL_NAME)
  const wireShape = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }
  assert.ok(JSON.stringify(wireShape).length < 360, 'compact schema budget')
  assert.ok(DISCLOSURE_TOOL_DESCRIPTION.length < 120, 'compact description budget')

  const args = { done: 'Checked A.', next: 'Check B.', approach: 'Read B.' }
  const value = await harness.executeTool(session, DISCLOSURE_TOOL_NAME, args)
  assert.deepEqual(tool.output.render(args, value), [], 'do not echo progress into model context')
})

test('empty checkpoint fields fail without resetting reminder accounting', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'empty-progress' }
  host.apply(harness.ctx, { reminderAfterCalls: 1, maxReminders: 2, activityWindowSize: 0 })
  harness.emit(session, TURN.start(1))

  harness.emit(session, assistantStep(1))
  assertNoticeShape(await harness.postExecute(session), 0)

  harness.emit(session, assistantStep(2, [{ type: 'tool-call', name: DISCLOSURE_TOOL_NAME }]))
  await assert.rejects(
    harness.executeTool(session, DISCLOSURE_TOOL_NAME, {
      done: ' ',
      next: 'Continue.',
      approach: 'Read the next file.',
    }),
    /must be non-empty/,
  )
  assert.equal((await harness.postExecute(
    session,
    { kind: 'accept' },
    { name: DISCLOSURE_TOOL_NAME },
    { result: { isError: true, content: [], value: null } },
  )).additionalContexts, undefined)

  harness.emit(session, assistantStep(3))
  assertNoticeShape(await harness.postExecute(session), 1)
})

test('the configured cadence yields repeats up to the interval budget', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'cadence' }
  host.apply(harness.ctx, { reminderAfterCalls: 8, maxReminders: 3 })
  harness.emit(session, TURN.start(1))

  const carriers = []
  for (let call = 1; call <= 32; call += 1) {
    harness.emit(session, assistantStep(call))
    const decision = await harness.postExecute(session)
    if (reminders(decision).length === 0) {
      assert.equal(decision.additionalContexts, undefined)
    } else {
      carriers.push(call)
      assertNoticeShape(decision, carriers.length - 1)
    }
  }
  assert.deepEqual(carriers, [8, 16, 24])
})

test('Assistant prose no longer resets disclosure accounting', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'prose-does-not-reset' }
  host.apply(harness.ctx, { reminderAfterCalls: 3, maxReminders: 1, activityWindowSize: 0 })
  harness.emit(session, TURN.start(1))

  harness.emit(session, assistantStep(1))
  await harness.postExecute(session)
  harness.emit(session, assistantStep(2))
  await harness.postExecute(session)

  harness.emit(session, assistantStep(3, [{
    type: 'text',
    text: 'Disclosure:\nDone: old format.\nNext: should not reset.\nApproach: prose only.',
  }]))
  assertNoticeShape(await harness.postExecute(session), 0)
})

test('disclose_progress resets cadence and restores the reminder budget without counting itself', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'tool-reset' }
  host.apply(harness.ctx, { reminderAfterCalls: 3, maxReminders: 1, activityWindowSize: 0 })
  harness.emit(session, TURN.start(1))

  for (let step = 1; step <= 3; step += 1) {
    harness.emit(session, assistantStep(step))
    const decision = await harness.postExecute(session)
    if (step === 3) assertNoticeShape(decision, 0)
    else assert.equal(decision.additionalContexts, undefined)
  }

  harness.emit(session, assistantStep(4))
  await disclose(harness, session, {
    done: 'Confirmed the first finding.',
    next: 'Inspect the remaining file.',
    approach: 'Read and compare the call path.',
  })

  for (let step = 5; step <= 7; step += 1) {
    harness.emit(session, assistantStep(step))
    const decision = await harness.postExecute(session)
    if (step === 7) assertNoticeShape(decision, 0)
    else assert.equal(decision.additionalContexts, undefined)
  }
})

test('nested PTC disclose_progress makes the whole run_code model step a checkpoint boundary', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'ptc-reset' }
  const parent = Symbol('run_code')
  host.apply(harness.ctx, { reminderAfterCalls: 2, maxReminders: 1, activityWindowSize: 0 })
  harness.emit(session, TURN.start(1))

  harness.emit(session, assistantStep(1))
  assert.equal((await harness.postExecute(session)).additionalContexts, undefined)

  harness.emit(session, assistantStep(2))
  await disclose(harness, session, {
    done: 'Inspected nested calls.',
    next: 'Continue the outer program.',
    approach: 'Let run_code finish, then verify.',
  }, { parent })

  // The enclosing top-level transport belongs to the same Assistant step as
  // the nested checkpoint, so settlement order cannot charge it to the fresh interval.
  assert.equal((await harness.postExecute(session, { kind: 'accept' }, { name: 'run_code' })).additionalContexts, undefined)

  harness.emit(session, assistantStep(3))
  assert.equal((await harness.postExecute(session, { kind: 'accept' }, { name: 'read' })).additionalContexts, undefined)
  harness.emit(session, assistantStep(4))
  assertNoticeShape(await harness.postExecute(session, { kind: 'accept' }, { name: 'read' }), 0)
})

test('native progress and parallel sibling tools form one settlement-order-independent checkpoint step', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'native-parallel-checkpoint' }
  host.apply(harness.ctx, { reminderAfterCalls: 1, maxReminders: 1, activityWindowSize: 0 })
  harness.emit(session, TURN.start(1))
  harness.emit(session, assistantStep(1, [
    { type: 'tool-call', name: DISCLOSURE_TOOL_NAME },
    { type: 'tool-call', name: 'read' },
  ]))

  // A sibling settles first and reaches the threshold, but the committed
  // Assistant message already contains a progress attempt, so no stale reminder
  // is delivered before that attempt resolves.
  assert.equal((await harness.postExecute(session, { kind: 'accept' }, { name: 'read' })).additionalContexts, undefined)

  await disclose(harness, session, {
    done: 'Checked the first file.',
    next: 'Continue with the second file.',
    approach: 'Read and compare it.',
  })

  // A sibling settling after the successful checkpoint is still part of the same
  // model step and is not charged to the newly opened interval.
  assert.equal((await harness.postExecute(session, { kind: 'accept' }, { name: 'search' })).additionalContexts, undefined)

  harness.emit(session, assistantStep(2))
  assertNoticeShape(await harness.postExecute(session, { kind: 'accept' }, { name: 'read' }), 0)
})

test('a failed direct progress attempt suppresses stale same-step reminders but does not reset accounting', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'failed-progress-attempt' }
  host.apply(harness.ctx, { reminderAfterCalls: 1, maxReminders: 1, activityWindowSize: 0 })
  harness.emit(session, TURN.start(1))
  harness.emit(session, assistantStep(1, [
    { type: 'tool-call', name: DISCLOSURE_TOOL_NAME },
    { type: 'tool-call', name: 'read' },
  ]))

  // The ordinary sibling makes a reminder due, but delivery waits for the
  // checkpoint attempt to settle.
  assert.equal((await harness.postExecute(session, { kind: 'accept' }, { name: 'read' })).additionalContexts, undefined)

  await assert.rejects(
    harness.executeTool(session, DISCLOSURE_TOOL_NAME, { done: 'missing fields' }),
    /required|next|approach/i,
  )
  // A failed progress dispatch is excluded from cadence and, crucially, did not
  // execute the reset body.
  assert.equal((await harness.postExecute(
    session,
    { kind: 'accept' },
    { name: DISCLOSURE_TOOL_NAME },
    { result: { isError: true, content: [], value: null } },
  )).additionalContexts, undefined)

  harness.emit(session, assistantStep(2))
  assertNoticeShape(await harness.postExecute(session, { kind: 'accept' }, { name: 'read' }), 0)
})

test('a progress checkpoint preserves recent activity but is excluded from the activity window itself', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'preserve-activity' }
  const parent = Symbol('run_code')
  host.apply(harness.ctx, {
    reminderAfterCalls: 1,
    maxReminders: 1,
    activityWindowSize: 4,
    inspectionHintMinInspections: 2,
  })
  harness.emit(session, TURN.start(1))

  for (let i = 0; i < 2; i += 1) {
    await harness.postExecute(session, { kind: 'accept' }, { name: 'read', parent })
  }
  await disclose(harness, session, {
    done: 'Compared records.',
    next: 'Check mapping.',
    approach: 'Read the index.',
  }, { parent })

  harness.emit(session, assistantStep(1))
  const fact = 'Recent window: 3/3 inspection/search, 0 mutation/verification by tool-name classification. If investigating further, name the unresolved fact.'
  assertNoticeShape(await harness.postExecute(session, { kind: 'accept' }, { name: 'read' }), 0, fact)
})

test('inspection-heavy activity adds only the compact factual suffix', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'activity-hint' }
  host.apply(harness.ctx, {
    reminderAfterCalls: 3,
    maxReminders: 1,
    activityWindowSize: 4,
    inspectionHintMinInspections: 3,
  })
  harness.emit(session, TURN.start(1))
  harness.emit(session, assistantStep(1))

  await harness.postExecute(session, { kind: 'accept' }, { name: 'read' })
  await harness.postExecute(session, { kind: 'accept' }, { name: 'grep' })
  const fact = 'Recent window: 3/3 inspection/search, 0 mutation/verification by tool-name classification. If investigating further, name the unresolved fact.'
  assertNoticeShape(await harness.postExecute(session, { kind: 'accept' }, { name: 'search_code' }), 0, fact)
})

test('a mutation-oriented operation suppresses the inspection suffix', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'activity-mutation' }
  host.apply(harness.ctx, { reminderAfterCalls: 3, maxReminders: 1 })
  harness.emit(session, TURN.start(1))
  harness.emit(session, assistantStep(1))

  await harness.postExecute(session, { kind: 'accept' }, { name: 'read' })
  await harness.postExecute(session, { kind: 'accept' }, { name: 'edit' })
  assertNoticeShape(await harness.postExecute(session, { kind: 'accept' }, { name: 'grep' }), 0, null)
})

test('nested ordinary tools enrich activity without advancing cadence', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'nested-activity' }
  const parent = Symbol('run_code')
  host.apply(harness.ctx, {
    reminderAfterCalls: 2,
    maxReminders: 1,
    activityWindowSize: 8,
    inspectionHintMinInspections: 5,
  })
  harness.emit(session, TURN.start(1))
  harness.emit(session, assistantStep(1))

  for (let i = 0; i < 5; i += 1) {
    assert.equal((await harness.postExecute(session, { kind: 'accept' }, { name: 'read', parent })).additionalContexts, undefined)
  }
  assert.equal((await harness.postExecute(session, { kind: 'accept' }, { name: 'run_code' })).additionalContexts, undefined)

  harness.emit(session, assistantStep(2))
  const fact = 'Recent window: 5/7 inspection/search, 0 mutation/verification by tool-name classification. If investigating further, name the unresolved fact.'
  assertNoticeShape(await harness.postExecute(session, { kind: 'accept' }, { name: 'run_code' }), 0, fact)
})

test('one model step can deliver at most one reminder even across several cadence periods', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'parallel-step' }
  host.apply(harness.ctx, { reminderAfterCalls: 8, maxReminders: 3, activityWindowSize: 0 })
  harness.emit(session, TURN.start(1))
  harness.emit(session, assistantStep(1))

  const decisions = await Promise.all(
    Array.from({ length: 24 }, (_, index) => harness.postExecute(session, { kind: 'accept' }, {}, {
      delayMs: (24 - index) % 5,
    })),
  )
  assert.equal(decisions.filter(decision => reminders(decision).length > 0).length, 1)

  // Calls 16 and 24 are already overdue, but the next budget slot is delivered
  // only after the model has had a chance to observe the first reminder.
  harness.emit(session, assistantStep(2))
  assertNoticeShape(await harness.postExecute(session), 1)
})

test('failed, denied, and blocked ordinary outcomes still advance cadence', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'outcomes' }
  host.apply(harness.ctx, { reminderAfterCalls: 3, maxReminders: 1, activityWindowSize: 0 })
  harness.emit(session, TURN.start(1))
  harness.emit(session, assistantStep(1))

  const denied = { isError: true, content: [], error: { name: 'Denied', code: 'POLICY_DENIED' } }
  const failed = { isError: true, content: [], error: { name: 'Failure', code: 'TOOL_FAILED' } }
  assert.equal((await harness.postExecute(session, { kind: 'accept' }, {}, { result: denied })).additionalContexts, undefined)
  assert.equal((await harness.postExecute(session)).additionalContexts, undefined)
  assertNoticeShape(await harness.postExecute(session, { kind: 'block', feedback: [] }, {}, { result: failed }), 0)
})

test('a throwing downstream policy advances cadence but does not spend the reminder slot', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'throwing-policy' }
  host.apply(harness.ctx, { reminderAfterCalls: 2, maxReminders: 1, activityWindowSize: 0 })
  harness.emit(session, TURN.start(1))
  harness.emit(session, assistantStep(1))

  await assert.rejects(
    harness.postExecute(session, undefined, {}, { downstreamError: new Error('downstream policy failed') }),
    /downstream policy failed/,
  )

  harness.emit(session, assistantStep(2))
  assertNoticeShape(await harness.postExecute(session), 0)
})

test('zero threshold or empty budget disables reminders while leaving disclose_progress available', { skip }, async () => {
  for (const config of [
    { reminderAfterCalls: 0, maxReminders: 3 },
    { reminderAfterCalls: 8, maxReminders: 0 },
  ]) {
    const harness = createHarness()
    const session = { id: `disabled-${config.reminderAfterCalls}-${config.maxReminders}` }
    host.apply(harness.ctx, { ...config, activityWindowSize: 0 })
    harness.emit(session, TURN.start(1))
    for (let step = 1; step <= 20; step += 1) {
      harness.emit(session, assistantStep(step))
      assert.equal((await harness.postExecute(session)).additionalContexts, undefined)
    }
    assert.ok(harness.tools.has(DISCLOSURE_TOOL_NAME))
  }
})

test('turn end discards accounting and a new turn starts clean', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'turn-lifecycle' }
  host.apply(harness.ctx, { reminderAfterCalls: 2, maxReminders: 1, activityWindowSize: 0 })
  harness.emit(session, TURN.start(1))
  harness.emit(session, assistantStep(1))
  await harness.postExecute(session)
  harness.emit(session, TURN.end(1))

  assert.equal((await harness.postExecute(session)).additionalContexts, undefined)

  harness.emit(session, TURN.start(2))
  harness.emit(session, assistantStep(1))
  assert.equal((await harness.postExecute(session)).additionalContexts, undefined)
  harness.emit(session, assistantStep(2))
  assertNoticeShape(await harness.postExecute(session), 0)
})

test('a blocked downstream decision keeps its shape and gets the reminder context', { skip }, async () => {
  const harness = createHarness()
  const session = { id: 'composition' }
  host.apply(harness.ctx, { reminderAfterCalls: 1, maxReminders: 1, activityWindowSize: 0 })
  harness.emit(session, TURN.start(1))
  harness.emit(session, assistantStep(1))

  const theirs = { role: 'user', source: { kind: 'other' }, content: [{ type: 'text', text: 'theirs' }] }
  const feedback = [{ type: 'text', text: 'call denied' }]
  const decision = await harness.postExecute(
    session,
    { kind: 'block', feedback, additionalContexts: [theirs] },
  )
  assert.equal(decision.kind, 'block')
  assert.deepEqual(decision.feedback, feedback)
  assertNoticeShape(decision, 0)
  assert.equal(decision.additionalContexts[1], theirs)
})
