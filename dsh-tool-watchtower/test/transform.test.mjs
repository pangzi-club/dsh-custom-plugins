/**
 * Pure-function tests for the transform kernel: config validation, the text
 * helpers, and the planTransform truth table across the four modes.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SECRET_MARK, contentText, planTransform, redactText, resolveTransform } from '../lib/host/transform.js'

test('resolveTransform defaults to off', () => {
  assert.deepEqual(resolveTransform(undefined), { tools: [], mode: 'off' })
})

test('resolveTransform fails loudly on a malformed mapping', () => {
  assert.throws(() => resolveTransform('nope'), /config\.transform must be a mapping/)
  assert.throws(() => resolveTransform({ mode: 'redact' }), /config\.transform\.tools/)
  assert.throws(() => resolveTransform({ tools: ['a', ''], mode: 'redact' }), /config\.transform\.tools/)
  assert.throws(() => resolveTransform({ tools: ['a'], mode: 'maybe' }), /config\.transform\.mode/)
})

test('resolveTransform copies the tools list', () => {
  const source = ['watchtower_echo']
  const config = resolveTransform({ tools: source, mode: 'annotate' })
  assert.deepEqual(config, { tools: ['watchtower_echo'], mode: 'annotate' })
  assert.notEqual(config.tools, source, 'the validated list must not alias the config object')
})

test('contentText joins text blocks; non-text blocks become empty lines', () => {
  assert.equal(contentText('nope'), '')
  assert.equal(contentText([]), '')
  assert.equal(
    contentText([
      { type: 'text', text: 'one' },
      { type: 'image', url: 'x' },
      { type: 'text', text: 'two' },
    ]),
    'one\n\ntwo',
  )
})

test('redactText replaces every marker occurrence', () => {
  assert.equal(redactText(`a ${SECRET_MARK} b ${SECRET_MARK}c`), 'a [redacted] b [redacted]c')
  assert.equal(redactText('clean'), 'clean')
})

test('planTransform covers the four-mode truth table', () => {
  const secret = `pw=${SECRET_MARK}`
  assert.equal(planTransform('off', false, secret), 'passthrough')
  assert.equal(planTransform('redact', false, secret), 'redact')
  assert.equal(planTransform('redact', false, 'clean'), 'passthrough')
  assert.equal(planTransform('block-secret', false, secret), 'block')
  assert.equal(planTransform('block-secret', false, 'clean'), 'passthrough')
  assert.equal(planTransform('annotate', false, 'clean'), 'annotate')
})

test('failed results are never re-processed, in any mode', () => {
  for (const mode of ['off', 'redact', 'annotate', 'block-secret']) {
    assert.equal(planTransform(mode, true, SECRET_MARK), 'passthrough')
  }
})
