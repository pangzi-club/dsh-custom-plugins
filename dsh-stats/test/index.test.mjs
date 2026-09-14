/**
 * Host-entry orchestration tests: the `apply` wiring itself — declared
 * services, the four registered side effects, the plugin-row config contract,
 * the v1 ping route, the two `tools/pre-execute` policies, and effect release.
 *
 * The end-to-end route and tool behaviour (folded body, memoization, argument
 * validation) lives in `routes.test.mjs`; the pure fold lives in `fold.test.mjs`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, inject, name } from '../lib/index.js'

const PING_PATH = '/dsh-stats/ping'
const SUMMARY_PATH = '/api/dsh-stats/summary'

/**
 * Minimal ctx capturing everything `apply` registers, with every disposer kept
 * so teardown can be asserted (the route/tool harness in `routes.test.mjs`
 * deliberately never disposes).
 */
function harness(config) {
  const state = {
    effects: 0,
    routes: [],
    fetchRoutes: [],
    tools: [],
    events: [],
    disposers: [],
  }
  state.ctx = {
    effect(effect) {
      state.effects += 1
      state.disposers.push(effect())
    },
    on(eventName, listener) {
      state.events.push({ eventName, listener })
      return () => {}
    },
    get() {
      return undefined
    },
    webServer: {
      register(route) {
        state.routes.push(route)
        return () => {
          state.routes.splice(state.routes.indexOf(route), 1)
        }
      },
    },
    connection: {
      fetch: {
        register(route) {
          state.fetchRoutes.push(route)
          return () => {
            state.fetchRoutes.splice(state.fetchRoutes.indexOf(route), 1)
          }
        },
      },
    },
    sessionQuery: {
      readSession: async () => ({ events: [], inheritedEventCount: 0 }),
    },
    tools: {
      register(definition) {
        state.tools.push(definition)
        return () => {
          state.tools.splice(state.tools.indexOf(definition), 1)
        }
      },
    },
  }
  apply(state.ctx, config)
  return state
}

/** One res double resolving after `end`, so handler bodies stay synchronous. */
function fakeRes() {
  const res = { status: 0, headers: undefined, body: undefined, done: undefined }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
  }
  res.end = (body) => {
    res.body = body
    res.resolve()
  }
  res.done = new Promise(resolve => { res.resolve = resolve })
  return res
}

/** Drive the registered ping handler for one method. */
async function ping(state, method) {
  const res = fakeRes()
  state.routes.find(route => route.path === PING_PATH).handler({ method }, res)
  await res.done
  return res
}

/** Error message of a synchronous `apply` rejection. */
function rejectionOf(config) {
  try {
    apply(harnessFreshCtx(), config)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return assert.fail('expected apply to reject the plugin-row config')
}

/** A bare throwing-only ctx: enough for `apply` to reach config validation. */
function harnessFreshCtx() {
  return {
    effect() {},
    on() {},
    get() {
      return undefined
    },
    webServer: { register: () => () => {} },
    connection: { fetch: { register: () => () => {} } },
    sessionQuery: { readSession: async () => ({ events: [] }) },
    tools: { register: () => () => {} },
  }
}

/** Replace `console.log` for one call and hand back everything it printed. */
function captureConsole(run) {
  const lines = []
  const original = console.log
  console.log = (...args) => { lines.push(args.join(' ')) }
  try {
    run()
  } finally {
    console.log = original
  }
  return lines
}

test('declares its service dependencies and a stable plugin name', () => {
  assert.equal(name, 'dsh-stats')
  assert.deepEqual(inject, ['webServer', 'connection', 'sessionQuery', 'tools'])
})

test('registers the ping route, the summary route, the tool, and its listeners', () => {
  const state = harness()
  assert.deepEqual(state.routes.map(route => ({ kind: route.kind, path: route.path })), [
    { kind: 'exact', path: PING_PATH },
  ])
  assert.deepEqual(state.fetchRoutes.map(route => route.path), [SUMMARY_PATH])
  assert.deepEqual(state.tools.map(definition => definition.name), ['session_stats'])
  assert.deepEqual(
    state.events.map(entry => entry.eventName),
    ['session/event', 'tools/pre-execute', 'tools/pre-execute'],
  )
  assert.equal(state.effects, state.disposers.length)
  assert.ok(state.disposers.every(dispose => typeof dispose === 'function'))
})

test('rejects a malformed plugin-row config at load time', () => {
  assert.match(rejectionOf('nope'), /config must be a mapping/)
  assert.match(rejectionOf({ label: '   ' }), /config\.label/)
  assert.match(rejectionOf({ label: 7 }), /config\.label/)
  assert.match(rejectionOf({ timestamp: 'yes' }), /config\.timestamp/)
})

test('GET answers the heartbeat JSON; other methods are refused', async () => {
  const state = harness({ label: 'my-stats', timestamp: false })
  const ok = await ping(state, 'GET')
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(ok.headers['cache-control'], 'no-store')
  assert.equal(String(ok.body), '{"ok":true,"plugin":"my-stats"}')
  assert.equal(Number(ok.headers['content-length']), Buffer.byteLength(String(ok.body)))

  const bad = await ping(state, 'POST')
  assert.equal(bad.status, 405)
  assert.equal(bad.headers.allow, 'GET, HEAD')
  assert.equal(bad.body, undefined)
})

test('the heartbeat carries a timestamp unless the config switches it off', async () => {
  const stamped = JSON.parse(String((await ping(harness(), 'GET')).body))
  assert.equal(stamped.plugin, 'dsh-stats')
  assert.match(stamped.now, /^\d{4}-\d{2}-\d{2}T/)
})

test('HEAD answers the same headers without a body', async () => {
  const res = await ping(harness(), 'HEAD')
  assert.equal(res.status, 200)
  assert.equal(Number(res.headers['content-length']) > 0, true)
  assert.equal(res.body, undefined)
})

test('unloading the plugin releases every registration', () => {
  const state = harness()
  for (const dispose of state.disposers) dispose()
  assert.deepEqual(state.routes, [])
  assert.deepEqual(state.fetchRoutes, [])
  assert.deepEqual(state.tools, [])
})

test('the first pre-execute observer logs and always releases the call', () => {
  const state = harness()
  // Listener order follows `apply`: the session/event memo marker first, then
  // the two pre-execute listeners (observer, then policy).
  assert.equal(state.events[0].eventName, 'session/event')
  const preExecute = state.events.filter(entry => entry.eventName === 'tools/pre-execute')
  assert.equal(preExecute.length, 2)
  let released = 0
  const lines = captureConsole(() => {
    preExecute[0].listener({ name: 'read' }, () => {
      released += 1
      return 'next'
    })
  })
  assert.equal(released, 1)
  assert.deepEqual(lines, ['[dsh-stats] tool call: read'])
})

test('the second pre-execute policy denies only a malformed session id', async () => {
  const state = harness()
  const policy = state.events.filter(entry => entry.eventName === 'tools/pre-execute')[1]
  const subject = session => ({ name: 'session_stats', arguments: { session } })
  let released = 0
  const next = () => {
    released += 1
    return 'next'
  }

  const denied = await policy.listener(subject('x'.repeat(201)), next)
  assert.deepEqual(denied, { kind: 'deny', reason: 'session id looks malformed' })
  assert.equal(released, 0)

  assert.equal(await policy.listener(subject('session-1'), next), 'next')
  assert.equal(released, 1)

  assert.equal(await policy.listener({ name: 'session_stats', arguments: {} }, next), 'next')
  assert.equal(await policy.listener({ name: 'read', arguments: {} }, next), 'next')
  assert.equal(released, 3)
})
