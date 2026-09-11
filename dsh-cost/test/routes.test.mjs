/**
 * Route tests: the Host half registers two authenticated exact routes and maps
 * every outcome (cost body, memoized reads, credential and transport failures)
 * to the stable JSON the pill renders.
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { apply, inject, name } from '../index.js'

const PEAK_TIME = Date.UTC(2026, 8, 11, 2, 0, 0)

/** Minimal ctx capturing the effects, routes, and event listeners the plugin registers. */
function harness({ readSession, config, credentials } = {}) {
  const routes = new Map()
  const effects = []
  const listeners = new Map()
  const ctx = {
    effect(fn) {
      effects.push(fn())
      return () => {}
    },
    on(name, listener) {
      listeners.set(name, listener)
      return () => {}
    },
    get(service) {
      return service === 'credentials' ? credentials : undefined
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return async () => { routes.delete(route.path) }
        },
      },
    },
    sessionQuery: {
      readSession: readSession ?? (async () => ({ events: [], inheritedEventCount: 0 })),
    },
  }
  apply(ctx, config)
  return { routes, effects, listeners }
}

const SESSION_ROUTE = '/api/dsh-cost/session'
const BALANCE_ROUTE = '/api/dsh-cost/balance'

const bodyOf = async response => response.json()

/** One session snapshot with a header plus one billed step. */
function snapshot() {
  return {
    inheritedEventCount: 0,
    events: [
      {
        type: 'request/header', seq: 1, time: PEAK_TIME,
        data: { header: { config: { provider: 'deepseek', model: 'deepseek-flash' } } },
      },
      {
        type: 'assistant/message', seq: 2, time: PEAK_TIME,
        data: {
          turn: 1, step: 1, message: { source: { provider: 'deepseek', model: 'deepseek-flash' } },
          usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 },
        },
      },
    ],
  }
}

afterEach(() => {
  delete process.env.DSH_COST_TEST_KEY
})

test('declares the connection and session-query dependencies', () => {
  assert.equal(name, 'dsh-cost')
  assert.deepEqual(inject, ['connection', 'sessionQuery'])
})

test('registers both routes as buffered GET handlers', () => {
  const { routes } = harness()
  assert.deepEqual([...routes.keys()].sort(), [BALANCE_ROUTE, SESSION_ROUTE])
  for (const route of routes.values()) {
    assert.deepEqual(route.methods, ['GET'])
    assert.equal(route.requestBody, 'buffered')
  }
})

test('requires a session id', async () => {
  const { routes } = harness()
  const response = await routes.get(SESSION_ROUTE).fetch(new Request('http://x/api/dsh-cost/session'))
  assert.equal(response.status, 400)
  assert.match((await bodyOf(response)).error, /session id is required/)
})

test('answers 404 when the session cannot be read', async () => {
  const { routes } = harness({ readSession: async () => { throw new Error('not found') } })
  const response = await routes.get(SESSION_ROUTE).fetch(new Request('http://x/api/dsh-cost/session?session=missing'))
  assert.equal(response.status, 404)
  assert.match((await bodyOf(response)).error, /not found/)
})

test('prices the folded session with the effective table', async () => {
  const { routes } = harness({ readSession: async () => snapshot() })
  const response = await routes.get(SESSION_ROUTE).fetch(new Request('http://x/api/dsh-cost/session?session=s1'))
  assert.equal(response.status, 200)
  const body = await bodyOf(response)
  assert.equal(body.sessionId, 's1')
  assert.equal(body.currency, 'CNY')
  assert.equal(body.priced, true)
  // Peak flash: 1M cache read (0.04) + 1M uncached input (2) + 1M output (8).
  assert.equal(body.total, 10.04)
  assert.deepEqual(body.routes[0], {
    provider: 'deepseek',
    model: 'deepseek-flash',
    uncachedInputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 0,
    outputTokens: 1_000_000,
    peakTokens: 3_000_000,
    peakAmount: 10.04,
    idleTokens: 0,
    idleAmount: 0,
    amount: 10.04,
  })
  assert.deepEqual(body.unpriced, [])
  assert.equal(body.samples, 1)
  assert.deepEqual(body.excluded, { inheritedEvents: 0 })
  assert.deepEqual(body.basis.peakWindows, [[9, 12], [14, 18]])
})

test('honours a row config price override and reports unpriced models', async () => {
  const { routes } = harness({
    readSession: async () => snapshot(),
    config: { pricing: { 'deepseek-flash': null, 'other/model': { cacheRead: 0, input: 3, output: 0 } } },
  })
  const body = await bodyOf(await routes.get(SESSION_ROUTE).fetch(new Request('http://x/api/dsh-cost/session?session=s1')))
  assert.equal(body.total, 0)
  assert.equal(body.priced, false)
  assert.deepEqual(body.unpriced, [{ provider: 'deepseek', model: 'deepseek-flash', tokens: 3_000_000 }])
})

test('memoizes a session fold until a billable settlement lands', async () => {
  let reads = 0
  const { routes, listeners } = harness({
    readSession: async () => {
      reads += 1
      return snapshot()
    },
  })
  const route = routes.get(SESSION_ROUTE)
  const first = await bodyOf(await route.fetch(new Request('http://x/api/dsh-cost/session?session=s1')))
  const second = await bodyOf(await route.fetch(new Request('http://x/api/dsh-cost/session?session=s1')))
  assert.equal(reads, 1)
  assert.deepEqual(first, second)
  // A non-billable event leaves the cached reading servable.
  listeners.get('session/event')({ id: 's1' }, { type: 'step/start' })
  await route.fetch(new Request('http://x/api/dsh-cost/session?session=s1'))
  assert.equal(reads, 1)
  // A settled usage sample invalidates it for the next request.
  listeners.get('session/event')({ id: 's1' }, { type: 'assistant/message' })
  await route.fetch(new Request('http://x/api/dsh-cost/session?session=s1'))
  assert.equal(reads, 2)
  // Events for another session never touch this entry.
  listeners.get('session/event')({ id: 'other' }, { type: 'assistant/message' })
  await route.fetch(new Request('http://x/api/dsh-cost/session?session=s1'))
  assert.equal(reads, 2)
})

test('reports a provider without a balance API', async () => {
  const { routes } = harness({ config: { provider: 'other' } })
  const body = await bodyOf(await routes.get(BALANCE_ROUTE).fetch(new Request('http://x/api/dsh-cost/balance')))
  assert.equal(body.available, false)
  assert.equal(body.reason, 'PROVIDER_UNSUPPORTED')
})

test('reports a missing credential', async () => {
  const { routes } = harness({ config: { apiKeyEnv: 'DSH_COST_TEST_KEY' } })
  const body = await bodyOf(await routes.get(BALANCE_ROUTE).fetch(new Request('http://x/api/dsh-cost/balance')))
  assert.equal(body.available, false)
  assert.equal(body.reason, 'MISSING_CREDENTIAL')
})

test('reads the credential from the managed store before the environment', async () => {
  process.env.DSH_COST_TEST_KEY = 'sk-ambient'
  const seen = []
  const { routes } = harness({
    config: { apiKeyEnv: 'DSH_COST_TEST_KEY' },
    credentials: { resolve: async ref => (ref === 'DSH_COST_TEST_KEY' ? { value: 'sk-stored' } : undefined) },
  })
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push(init.headers.authorization)
    return { ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [] }) }
  }
  try {
    const body = await bodyOf(await routes.get(BALANCE_ROUTE).fetch(new Request('http://x/api/dsh-cost/balance')))
    assert.equal(body.available, true)
    assert.deepEqual(body.rows, [])
    assert.deepEqual(seen, ['Bearer sk-stored'])
  } finally {
    globalThis.fetch = original
  }
})

test('maps provider failures into stable unavailable reasons', async () => {
  const cases = [
    [{ ok: false, status: 401 }, 'UNAUTHORIZED'],
    [{ ok: false, status: 500 }, 'HTTP_500'],
    [{ ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: 'CNY' }) }, 'MALFORMED_RESPONSE'],
  ]
  for (const [response, reason] of cases) {
    process.env.DSH_COST_TEST_KEY = 'sk-test'
    const { routes } = harness({ config: { apiKeyEnv: 'DSH_COST_TEST_KEY' } })
    const original = globalThis.fetch
    globalThis.fetch = async () => response
    try {
      const body = await bodyOf(await routes.get(BALANCE_ROUTE).fetch(new Request('http://x/api/dsh-cost/balance')))
      assert.equal(body.available, false)
      assert.equal(body.reason, reason)
    } finally {
      globalThis.fetch = original
    }
  }
})

test('maps a transport failure to NETWORK', async () => {
  process.env.DSH_COST_TEST_KEY = 'sk-test'
  const { routes } = harness({ config: { apiKeyEnv: 'DSH_COST_TEST_KEY' } })
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('socket hang up') }
  try {
    const body = await bodyOf(await routes.get(BALANCE_ROUTE).fetch(new Request('http://x/api/dsh-cost/balance')))
    assert.equal(body.reason, 'NETWORK')
    assert.match(body.message, /socket hang up/)
  } finally {
    globalThis.fetch = original
  }
})

test('falls back to the launching environment for the credential', async () => {
  process.env.DSH_COST_TEST_KEY = 'sk-ambient'
  const seen = []
  const { routes } = harness({ config: { apiKeyEnv: 'DSH_COST_TEST_KEY' } })
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push(init.headers.authorization)
    return { ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [] }) }
  }
  try {
    await routes.get(BALANCE_ROUTE).fetch(new Request('http://x/api/dsh-cost/balance'))
    assert.deepEqual(seen, ['Bearer sk-ambient'])
  } finally {
    globalThis.fetch = original
  }
})
