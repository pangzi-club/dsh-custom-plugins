/**
 * Orchestration tests: the Host half registers the authenticated summary
 * route and the session_stats tool, and maps every outcome (missing id,
 * unreadable session, folded body, memoized reads) to stable JSON.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, inject, name } from '../lib/index.js'

const SUMMARY_ROUTE = '/api/dsh-stats/summary'

/** Minimal ctx capturing effects, routes, tools, and event listeners. */
function harness({ readSession, config } = {}) {
  const routes = new Map()
  const tools = new Map()
  const listeners = new Map()
  const disposers = []
  const ctx = {
    effect(fn) {
      disposers.push(fn())
      return () => {}
    },
    on(eventName, listener) {
      listeners.set(eventName, listener)
      return () => {}
    },
    get() {
      return undefined
    },
    webServer: {
      register() { return () => {} },
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
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
    },
  }
  apply(ctx, config)
  return { routes, tools, listeners, disposers }
}

/** One session snapshot with a header plus one billed sample. */
function snapshot() {
  return {
    inheritedEventCount: 0,
    events: [
      {
        type: 'request/header', seq: 1, time: Date.UTC(2026, 8, 11, 2, 0, 0),
        data: { header: { config: { provider: 'deepseek', model: 'deepseek-flash' } } },
      },
      {
        type: 'assistant/message', seq: 2, time: Date.UTC(2026, 8, 11, 2, 0, 0),
        data: {
          turn: 1, step: 1,
          message: { source: { provider: 'deepseek', model: 'deepseek-flash' } },
          usage: { inputTokens: 1_000, outputTokens: 2_000, cacheReadTokens: 500 },
        },
      },
    ],
  }
}

const bodyOf = async response => response.json()

test('declares its service dependencies', () => {
  assert.equal(name, 'dsh-stats')
  assert.deepEqual(inject, ['webServer', 'connection', 'sessionQuery', 'tools'])
})

test('registers the summary route as a buffered GET handler', () => {
  const { routes } = harness()
  const route = routes.get(SUMMARY_ROUTE)
  assert.ok(route, 'the summary route is registered')
  assert.deepEqual(route.methods, ['GET'])
  assert.equal(route.requestBody, 'buffered')
})

test('requires a session id', async () => {
  const { routes } = harness()
  const response = await routes.get(SUMMARY_ROUTE).fetch(new Request('http://x/api/dsh-stats/summary'))
  assert.equal(response.status, 400)
  assert.match((await bodyOf(response)).error, /session id is required/)
})

test('answers 404 when the session cannot be read', async () => {
  const { routes } = harness({ readSession: async () => { throw new Error('not found') } })
  const response = await routes.get(SUMMARY_ROUTE)
    .fetch(new Request('http://x/api/dsh-stats/summary?session=missing'))
  assert.equal(response.status, 404)
  assert.match((await bodyOf(response)).error, /not found/)
})

test('answers the priced summary under the configured label', async () => {
  const { routes } = harness({ readSession: async () => snapshot(), config: { label: 'my-stats' } })
  const response = await routes.get(SUMMARY_ROUTE)
    .fetch(new Request('http://x/api/dsh-stats/summary?session=s1'))
  assert.equal(response.status, 200)
  const body = await bodyOf(response)
  assert.equal(body.label, 'my-stats')
  assert.equal(body.currency, 'CNY')
  assert.equal(body.priced, true)
  assert.equal(body.samples, 1)
  assert.deepEqual(body.unpriced, [])
  // Friday 10:00 Asia/Shanghai → peak flash: 500×0.04 + 1000×2 + 2000×8 per 1M.
  assert.ok(Math.abs(body.total - 0.01802) < 1e-9)
  const route = body.routes[0]
  assert.equal(route.provider, 'deepseek')
  assert.equal(route.model, 'deepseek-flash')
  assert.equal(route.uncachedInputTokens, 1_000)
  assert.equal(route.cacheReadTokens, 500)
  assert.equal(route.cacheWriteTokens, 0)
  assert.equal(route.outputTokens, 2_000)
  assert.equal(route.peakTokens, 3_500)
  assert.equal(route.idleTokens, 0)
  assert.ok(Math.abs(route.peakAmount - 0.01802) < 1e-9)
  assert.ok(Math.abs(route.amount - 0.01802) < 1e-9)
})

test('honours a pricing override and reports unpriced models', async () => {
  const { routes } = harness({
    readSession: async () => snapshot(),
    config: { pricing: { 'deepseek-flash': null, 'other/model': { cacheRead: 0, input: 3, output: 0 } } },
  })
  const body = await bodyOf(await routes.get(SUMMARY_ROUTE)
    .fetch(new Request('http://x/api/dsh-stats/summary?session=s1')))
  assert.equal(body.priced, false)
  assert.equal(body.total, 0)
  assert.deepEqual(body.unpriced, [{ provider: 'deepseek', model: 'deepseek-flash', tokens: 3_500 }])
})

test('memoizes a fold until a usage sample lands', async () => {
  let reads = 0
  const { routes, listeners } = harness({
    readSession: async () => {
      reads += 1
      return snapshot()
    },
  })
  const route = routes.get(SUMMARY_ROUTE)
  await route.fetch(new Request('http://x/api/dsh-stats/summary?session=s1'))
  await route.fetch(new Request('http://x/api/dsh-stats/summary?session=s1'))
  assert.equal(reads, 1)
  listeners.get('session/event')({ id: 's1' }, { type: 'assistant/message' })
  await route.fetch(new Request('http://x/api/dsh-stats/summary?session=s1'))
  assert.equal(reads, 2)
})

test('registers a session_stats tool that validates its own arguments', async () => {
  const { tools } = harness({ readSession: async () => snapshot() })
  const tool = tools.get('session_stats')
  assert.ok(tool, 'the tool is registered')
  assert.equal(tool.parameters.required[0], 'session')
  assert.equal(tool.output.schema.type, 'object')
  await assert.rejects(tool.execute({}), /arguments\.session/)
  const value = await tool.execute({ session: 's1' })
  assert.equal(value.samples, 1)
  assert.equal(value.routes[0].model, 'deepseek-flash')
})
