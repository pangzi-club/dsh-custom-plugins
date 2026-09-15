/**
 * Pure-function tests for the gate rules: config parsing (fail-loudly paths)
 * and first-match-wins evaluation with the default allow.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decide, resolveRules } from '../lib/host/rules.js'

test('resolveRules treats a missing rule list as "no rules"', () => {
  assert.deepEqual(resolveRules(undefined), [])
})

test('resolveRules fails loudly with the offending path', () => {
  assert.throws(() => resolveRules('nope'), /config\.rules must be an array/)
  assert.throws(() => resolveRules(['x']), /config\.rules\[0\] must be a mapping/)
  assert.throws(() => resolveRules([{ decision: 'allow' }]), /config\.rules\[0\]\.tool/)
  assert.throws(() => resolveRules([{ tool: '   ' }]), /config\.rules\[0\]\.tool/)
  assert.throws(() => resolveRules([{ tool: 'x', decision: 'maybe' }]), /config\.rules\[0\]\.decision/)
  assert.throws(() => resolveRules([{ tool: 'x', decision: 'deny', reason: '  ' }]), /config\.rules\[0\]\.reason/)
})

test('resolveRules keeps array order and drops an absent reason', () => {
  const rules = resolveRules([
    { tool: 'web_fetch', decision: 'ask', reason: 'outbound fetches need a human nod' },
    { tool: 'write', decision: 'deny', reason: 'read-only session' },
    { tool: '*', decision: 'allow' },
  ])
  assert.deepEqual(rules, [
    { tool: 'web_fetch', decision: 'ask', reason: 'outbound fetches need a human nod' },
    { tool: 'write', decision: 'deny', reason: 'read-only session' },
    { tool: '*', decision: 'allow' },
  ])
})

test('decide is first-match-wins with a default allow', () => {
  const rules = resolveRules([
    { tool: 'web_fetch', decision: 'ask' },
    { tool: '*', decision: 'deny', reason: 'closed' },
  ])
  assert.deepEqual(decide(rules, 'web_fetch'), { kind: 'ask' })
  assert.deepEqual(decide(rules, 'read'), { kind: 'deny', reason: 'closed' })
  assert.deepEqual(decide([], 'read'), { kind: 'allow' })
})

test('decide only matches exact names; the wildcard is spelled *', () => {
  const rules = resolveRules([{ tool: 'write', decision: 'deny', reason: 'no' }])
  assert.deepEqual(decide(rules, 'write'), { kind: 'deny', reason: 'no' })
  assert.deepEqual(decide(rules, 'write_file'), { kind: 'allow' })
  assert.deepEqual(decide(rules, 'wr'), { kind: 'allow' })
})

test('a deny without a configured reason still explains itself', () => {
  const verdict = decide(resolveRules([{ tool: 'write', decision: 'deny' }]), 'write')
  assert.equal(verdict.kind, 'deny')
  assert.match(verdict.reason, /denied by rule/)
})

test('an ask carries its reason; a plain allow asserts nothing extra', () => {
  assert.deepEqual(
    decide(resolveRules([{ tool: 'web_fetch', decision: 'ask', reason: 'nod first' }]), 'web_fetch'),
    { kind: 'ask', reason: 'nod first' },
  )
  assert.deepEqual(decide(resolveRules([{ tool: 'web_fetch', decision: 'ask' }]), 'web_fetch'), { kind: 'ask' })
  assert.deepEqual(decide(resolveRules([{ tool: '*', decision: 'allow' }]), 'read'), { kind: 'allow' })
})
