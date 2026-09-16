import test from 'node:test'
import assert from 'node:assert/strict'
import {
  combinedBlockedReason,
  combinedReminderText,
  hasUnfinishedTodos,
  isMeaningfulVisibleAssistant,
  PROGRESS_POLICY_TEXT,
  progressBlockedReason,
  progressReminderText,
  resolveConfig,
  shouldCountTool,
  todoBlockedReason,
  todoReminderText,
  visibleAssistantTextLength,
} from '../lib/policy.js'

test('default config resolves to TODO 6/10 and progress 8/12', () => {
  assert.deepEqual(resolveConfig(), {
    reminderAfterCalls: 6,
    blockAfterCalls: 10,
    progressReminderAfterCalls: 8,
    progressBlockAfterCalls: 12,
    progressMinChars: 24,
    installProgressPolicy: true,
    reconcileOnTurnStop: true,
    exemptTools: [],
  })
})

test('invalid threshold pairs fail closed', () => {
  assert.throws(() => resolveConfig({ reminderAfterCalls: 10, blockAfterCalls: 10 }))
  assert.throws(() => resolveConfig({ reminderAfterCalls: 0 }))
  assert.throws(() => resolveConfig({ progressReminderAfterCalls: 12, progressBlockAfterCalls: 12 }))
  assert.throws(() => resolveConfig({ progressMinChars: 0 }))
})

test('exempt tools are trimmed and deduplicated', () => {
  const config = resolveConfig({ exemptTools: ['  session_search ', 'session_search', '', 'skill'] })
  assert.deepEqual(config.exemptTools, ['session_search', 'skill'])
})

test('unfinished status detection is conservative', () => {
  assert.equal(hasUnfinishedTodos([]), false)
  assert.equal(hasUnfinishedTodos([{ status: 'completed' }]), false)
  assert.equal(hasUnfinishedTodos([{ status: 'completed' }, { status: 'pending' }]), true)
  assert.equal(hasUnfinishedTodos([{ status: 'weird-future-status' }]), true)
})

test('todo_write and top-level run_code do not consume freshness budgets', () => {
  const exempt = new Set(['skill'])
  assert.equal(shouldCountTool('todo_write', false, exempt), false)
  assert.equal(shouldCountTool('run_code', false, exempt), false)
  assert.equal(shouldCountTool('run_code', true, exempt), true)
  assert.equal(shouldCountTool('skill', false, exempt), false)
  assert.equal(shouldCountTool('bash', false, exempt), true)
})

test('visible assistant length ignores reasoning and whitespace', () => {
  assert.equal(visibleAssistantTextLength([
    { type: 'reasoning', text: 'private reasoning should not count' },
    { type: 'text', text: '  根因 已确认\n下一步 补 测试  ' },
  ]), Array.from('根因已确认下一步补测试').length)
})

test('meaningful visible assistant threshold is configurable', () => {
  const short = [{ type: 'text', text: '继续处理。' }]
  const useful = [{ type: 'text', text: '根因已经确认是缓存键缺少 workspace scope；下一步修改实现并补回归测试。' }]
  assert.equal(isMeaningfulVisibleAssistant(short, 24), false)
  assert.equal(isMeaningfulVisibleAssistant(useful, 24), true)
})

test('TODO and progress reminders are actionable and carry thresholds', () => {
  assert.match(todoBlockedReason(10, 10), /todo_write/)
  assert.match(todoReminderText(6, 10), /6/)
  assert.match(progressBlockedReason(12, 12, 24), /user-visible/)
  assert.match(progressBlockedReason(12, 12, 24), /24/)
  assert.match(progressReminderText(8, 12), /8/)
  assert.match(progressReminderText(8, 12), /12/)
})

test('combined reminder and block explain both stale lanes', () => {
  const config = resolveConfig()
  const reminder = combinedReminderText({ todoCalls: 6, progressCalls: 8, config })
  const blocked = combinedBlockedReason({ todoCalls: 10, progressCalls: 12, config })
  assert.match(reminder, /todo checkpoint/)
  assert.match(reminder, /progress checkpoint/)
  assert.match(blocked, /TODO checkpoint required/)
  assert.match(blocked, /Progress checkpoint required/)
})

test('progress system policy is high-information and CoT-safe', () => {
  assert.match(PROGRESS_POLICY_TEXT, /high-information/)
  assert.match(PROGRESS_POLICY_TEXT, /plan changes/)
  assert.match(PROGRESS_POLICY_TEXT, /Do not expose chain-of-thought/)
})
