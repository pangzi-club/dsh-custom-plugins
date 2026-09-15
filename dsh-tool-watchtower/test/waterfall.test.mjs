/**
 * Orchestration tests for the event pipeline: what `apply` registers, and the
 * waterfall behaviour contracts — delegation vs veto, first-match-wins, the
 * transform's delegate-then-overlay posture, and the wrapper→observer timing
 * handoff.
 *
 * Pure-function coverage lives in rules/transform/activity tests; the bundle
 * envelope lives in bundle.test.mjs. Like every suite here, this runs on the
 * BUILD OUTPUT (../lib/) — `node build.mjs` first.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, inject, name } from '../lib/index.js'
import { SECRET_MARK } from '../lib/host/transform.js'

const PING_PATH = '/dsh-tool-watchtower/ping'
const ACTIVITY_PATH = '/api/dsh-tool-watchtower/activity'

/**
 * Minimal ctx capturing everything `apply` registers. Events are kept in
 * registration order — composeWaterfall relies on that being cordis's chain
 * order.
 */
function harness(config) {
  const state = {
    effects: [],
    routes: [],
    fetchRoutes: [],
    tools: [],
    events: [],
  }
  state.ctx = {
    effect(fn, label) {
      state.effects.push({ dispose: fn(), label })
    },
    on(eventName, listener) {
      state.events.push({ eventName, listener })
      return () => {}
    },
    webServer: {
      register(route) {
        state.routes.push(route)
        return () => {}
      },
    },
    connection: {
      fetch: {
        register(route) {
          state.fetchRoutes.push(route)
          return () => {}
        },
      },
    },
    tools: {
      register(definition) {
        state.tools.push(definition)
        return () => {}
      },
    },
  }
  apply(state.ctx, config)

  // Read a session's activity through the registered API — behaviour, not the
  // closure's internals, so refactors of sessions/logOf don't break the suite.
  state.activityOf = sessionId => ({
    snapshot: async () => {
      const route = state.fetchRoutes.find(candidate => candidate.path === ACTIVITY_PATH)
      const response = await route.fetch(
        new Request(`http://watchtower.test${ACTIVITY_PATH}?session=${encodeURIComponent(sessionId)}`),
      )
      return response.json()
    },
  })
  return state
}

/** Error message of a synchronous `apply` rejection. */
function rejectionOf(config) {
  const ctx = {
    effect() {},
    on() {},
    webServer: { register: () => () => {} },
    connection: { fetch: { register: () => () => {} } },
    tools: { register: () => () => {} },
  }
  try {
    apply(ctx, config)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return assert.fail('expected apply to reject the plugin-row config')
}

/**
 * Compose registered listeners into one waterfall chain, cordis-style: the
 * first-registered listener runs first, its next() reaches the second, …, and
 * `terminal` runs when the chain runs out — it plays the framework's default
 * behaviour, so it is also the assertion point for "downstream was reached".
 */
function composeWaterfall(listeners, terminal) {
  return async (...payload) => {
    const call = index => {
      if (index >= listeners.length) return terminal(...payload)
      return listeners[index](...payload, () => call(index + 1))
    }
    return call(0)
  }
}

const gateListeners = state => state.events.filter(e => e.eventName === 'tools/pre-execute').map(e => e.listener)
const transformListeners = state => state.events.filter(e => e.eventName === 'tools/post-execute').map(e => e.listener)

const EXEC = { name: 'watchtower_echo', callId: 'c1', agent: { session: { id: 's1' } } }
const RESULT = { isError: false, value: { echoed: 'x' }, content: [{ type: 'text', text: 'x' }] }

test('declares its service dependencies and a stable plugin name', () => {
  assert.equal(name, 'dsh-tool-watchtower')
  assert.deepEqual(inject, ['webServer', 'connection', 'tools'])
})

test('registers the ping route, the activity API, two tools, and the eight listeners', () => {
  const state = harness()
  assert.deepEqual(state.routes.map(route => ({ kind: route.kind, path: route.path })), [
    { kind: 'exact', path: PING_PATH },
  ])
  assert.deepEqual(state.fetchRoutes.map(route => route.path), [ACTIVITY_PATH])
  assert.deepEqual(state.tools.map(definition => definition.name), ['watchtower_echo', 'watchtower_report'])
  assert.deepEqual(
    state.events.map(entry => entry.eventName),
    [
      'tools/execute',
      'tools/result',
      'agent/assistant-stream',
      'tools/pre-execute',
      'tools/post-execute',
      'llm/stream',
      'session/event',
      'agent/inbox/inserted',
    ],
  )
  assert.ok(state.effects.every(effect => typeof effect.dispose === 'function'))
})

test('rejects a malformed plugin-row config at load time', () => {
  assert.match(rejectionOf('nope'), /config must be a mapping/)
  assert.match(rejectionOf({ rules: 'nope' }), /config\.rules must be an array/)
  assert.match(rejectionOf({ rules: [{ tool: 'x', decision: 'maybe' }] }), /config\.rules\[0\]\.decision/)
  assert.match(rejectionOf({ transform: { tools: 'x', mode: 'redact' } }), /config\.transform\.tools/)
  assert.match(rejectionOf({ transform: { tools: ['a'], mode: 'nope' } }), /config\.transform\.mode/)
})

test('GET answers the heartbeat JSON; other methods are refused', async () => {
  const state = harness()
  const res = { status: 0, headers: undefined, body: undefined }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
  }
  res.end = (body) => { res.body = body }
  const handler = state.routes.find(route => route.path === PING_PATH).handler

  handler({ method: 'GET' }, res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  const body = JSON.parse(String(res.body))
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'dsh-tool-watchtower')
  assert.equal(typeof body.sessions, 'number')

  handler({ method: 'POST' }, res)
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET, HEAD')
})

test('the activity API answers an empty snapshot for unknown sessions, 400 without a session', async () => {
  const state = harness()
  const route = state.fetchRoutes.find(candidate => candidate.path === ACTIVITY_PATH)
  const empty = await route.fetch(new Request(`http://watchtower.test${ACTIVITY_PATH}?session=nope`))
  assert.equal(empty.status, 200)
  const body = await empty.json()
  assert.equal(body.revision, 0)
  assert.deepEqual(body.records, [])

  const bad = await route.fetch(new Request(`http://watchtower.test${ACTIVITY_PATH}`))
  assert.equal(bad.status, 400)
})

test('the gate delegates when no rule matches and vetoes when one does', async () => {
  const state = harness({
    rules: [{ tool: 'write', decision: 'deny', reason: 'read-only session' }],
  })

  // No match → next() runs; with the chain exhausted the framework default
  // (the terminal) decides.
  const delegating = composeWaterfall(gateListeners(state), () => ({ kind: 'allow' }))
  const allowed = await delegating({ ...EXEC, name: 'read' })
  assert.deepEqual(allowed, { kind: 'allow' })

  // Match → the veto wins, and the throwing terminal proves the chain stopped.
  const guarded = composeWaterfall(gateListeners(state), () => {
    throw new Error('downstream must not be reached on a veto')
  })
  const veto = await guarded({ ...EXEC, name: 'write' })
  assert.deepEqual(veto, { kind: 'deny', reason: 'read-only session' })
})

test('an allow is a delegation, not an assertion: a downstream veto still wins', async () => {
  // '*' says allow; the chain end (a downstream vetoer here) denies. The gate
  // must not have short-circuited it.
  const state = harness({ rules: [{ tool: '*', decision: 'allow' }] })
  const chain = composeWaterfall(gateListeners(state), () => ({ kind: 'deny', reason: 'guard says no' }))
  const verdict = await chain(EXEC)
  assert.deepEqual(verdict, { kind: 'deny', reason: 'guard says no' })
})

test('first match wins: order beats specificity', async () => {
  const state = harness({
    rules: [
      { tool: '*', decision: 'allow' },
      { tool: 'write', decision: 'deny', reason: 'never reached' },
    ],
  })
  const chain = composeWaterfall(gateListeners(state), () => ({ kind: 'allow' }))
  const verdict = await chain({ ...EXEC, name: 'write' })
  assert.deepEqual(verdict, { kind: 'allow' })
})

test('a veto is audited into the session log as a decision record', async () => {
  const state = harness({
    rules: [{ tool: 'write', decision: 'deny', reason: 'read-only session' }],
  })
  const chain = composeWaterfall(gateListeners(state), () => ({ kind: 'allow' }))
  await chain({ ...EXEC, name: 'write' })
  const { records, totals } = await state.activityOf('s1').snapshot()
  const decision = records.find(record => record.kind === 'decision')
  assert.equal(decision.decision, 'deny')
  assert.equal(decision.reason, 'read-only session')
  assert.equal(totals.denied, 1)
})

test('redact replaces the projection and consults downstream first', async () => {
  const state = harness({
    transform: { tools: ['watchtower_echo'], mode: 'redact' },
  })
  let downstreamReached = false
  const chain = composeWaterfall(transformListeners(state), () => {
    downstreamReached = true
    return { kind: 'accept' }
  })
  const secret = { ...RESULT, content: [{ type: 'text', text: `pw=${SECRET_MARK}123` }] }
  const decision = await chain(EXEC, secret)
  assert.equal(downstreamReached, true, 'the transform delegates before overlaying')
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content[0].text, 'pw=[redacted]123')
})

test('results outside the configured tools pass through untouched', async () => {
  const state = harness({
    transform: { tools: ['watchtower_echo'], mode: 'redact' },
  })
  const chain = composeWaterfall(transformListeners(state), () => ({ kind: 'accept' }))
  const decision = await chain(
    { ...EXEC, name: 'read' },
    { ...RESULT, content: [{ type: 'text', text: SECRET_MARK }] },
  )
  assert.deepEqual(decision, { kind: 'accept' })
})

test('block ends the chain on purpose', async () => {
  const state = harness({
    transform: { tools: ['watchtower_echo'], mode: 'block-secret' },
  })
  const chain = composeWaterfall(transformListeners(state), () => {
    throw new Error('unreachable')
  })
  const secret = { ...RESULT, content: [{ type: 'text', text: SECRET_MARK }] }
  const decision = await chain(EXEC, secret)
  assert.equal(decision.kind, 'block')
  assert.match(decision.feedback[0].text, /Re-run without embedding secrets/)
})

test('annotate folds onto the downstream decision and respects a block', async () => {
  const state = harness({
    transform: { tools: ['watchtower_echo'], mode: 'annotate' },
  })

  // Downstream accepts → the notice rides on top.
  const chainAccept = composeWaterfall(transformListeners(state), () => ({ kind: 'accept' }))
  const folded = await chainAccept(EXEC, RESULT)
  assert.equal(folded.kind, 'accept')
  assert.equal(folded.additionalContexts.length, 1)
  assert.equal(folded.additionalContexts[0].source.plugin, 'dsh-tool-watchtower')

  // Downstream blocks → the transform must NOT un-block it.
  const chainBlock = composeWaterfall(transformListeners(state), () => ({ kind: 'block', feedback: [{ type: 'text', text: 'no' }] }))
  const respected = await chainBlock(EXEC, RESULT)
  assert.equal(respected.kind, 'block')
})

test('the wrapper times the dispatch and the result observer banks it', async () => {
  const state = harness({})
  const execute = composeWaterfall(
    state.events.filter(e => e.eventName === 'tools/execute').map(e => e.listener),
    () => ({ isError: false, value: {} }),
  )
  await execute(EXEC)

  const resultListener = state.events.find(e => e.eventName === 'tools/result').listener
  resultListener(EXEC, { isError: false, value: {} })
  const { records } = await state.activityOf('s1').snapshot()
  const tool = records.find(record => record.kind === 'tool')
  assert.equal(tool.name, 'watchtower_echo')
  assert.equal(typeof tool.durationMs, 'number')
})

test('the report tool serves the tower snapshot, bounded and defaulted to the caller', async () => {
  const state = harness({})
  const report = state.tools.find(definition => definition.name === 'watchtower_report')

  const own = await report.execute({}, { agent: { session: { id: 's9' } } })
  assert.equal(own.session, 's9')
  assert.deepEqual(own.records, [])

  const resultListener = state.events.find(e => e.eventName === 'tools/result').listener
  for (let index = 0; index < 40; index += 1) {
    resultListener({ ...EXEC, agent: { session: { id: 's9' } } }, { isError: false, value: {} })
  }
  const bounded = await report.execute({}, { agent: { session: { id: 's9' } } })
  assert.equal(bounded.records.length, 32, 'the model-facing payload is capped')
})

test('the echo tool validates its own arguments', async () => {
  const state = harness({})
  const echo = state.tools.find(definition => definition.name === 'watchtower_echo')
  assert.deepEqual(await echo.execute({ text: 'hi' }), { echoed: 'hi' })
  await assert.rejects(echo.execute({ text: 3 }), /arguments\.text must be a string/)
})
