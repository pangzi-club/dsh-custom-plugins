/**
 * Tests for dsh-stats v1: the plugin claims one exact route, and that route
 * answers GET/HEAD with the heartbeat JSON and rejects other methods.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, inject, name } from '../index.js'

function fakeCtx() {
  const state = { routes: [], disposers: [], effects: 0 }
  return {
    state,
    ctx: {
      effect(effect) {
        state.effects += 1
        state.disposers.push(effect())
      },
      webServer: {
        register(route) {
          state.routes.push(route)
          return () => {
            state.routes.splice(state.routes.indexOf(route), 1)
          }
        }
      }
    }
  }
}

function fakeRes() {
  const res = { status: 0, headers: undefined, body: undefined }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
  }
  res.end = (body) => {
    res.body = body
  }
  return res
}

test('declares the webserver dependency and a stable plugin name', () => {
  assert.equal(name, 'dsh-stats')
  assert.deepEqual(inject, ['webServer'])
})

test('claims exactly the ping path with one exact route', () => {
  const { ctx, state } = fakeCtx()
  apply(ctx)
  assert.equal(state.routes.length, 1)
  assert.deepEqual(
    { kind: state.routes[0].kind, path: state.routes[0].path },
    { kind: 'exact', path: '/dsh-stats/ping' },
  )
})

test('unloading the plugin releases the route', () => {
  const { ctx, state } = fakeCtx()
  apply(ctx)
  for (const dispose of state.disposers) dispose()
  assert.equal(state.routes.length, 0)
})

test('GET answers the heartbeat JSON; other methods are refused', () => {
  const { ctx, state } = fakeCtx()
  apply(ctx)
  const ok = fakeRes()
  state.routes[0].handler({ method: 'GET' }, ok)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['content-type'], 'application/json; charset=utf-8')
  const body = JSON.parse(String(ok.body))
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'dsh-stats')
  assert.equal(Number(ok.headers['content-length']), Buffer.byteLength(String(ok.body)))

  const bad = fakeRes()
  state.routes[0].handler({ method: 'POST' }, bad)
  assert.equal(bad.status, 405)
  assert.equal(bad.headers.allow, 'GET, HEAD')
})
