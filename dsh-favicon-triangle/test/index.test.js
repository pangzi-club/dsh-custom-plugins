/**
 * Tests for the favicon-triangle plugin: the plugin claims one exact route, and
 * that route answers GET/HEAD with the triangle SVG and rejects other methods.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, inject, name } from '../index.js'

/** Minimal cordis-shaped ctx capturing the effect and route the plugin registers. */
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
        },
      },
    },
  }
}

/** Minimal Node response double recording status, headers, and body. */
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
  assert.equal(name, 'favicon-triangle')
  assert.deepEqual(inject, ['webServer'])
})

test('claims exactly the favicon path with one exact route', () => {
  const { ctx, state } = fakeCtx()
  apply(ctx)
  assert.equal(state.routes.length, 1)
  assert.deepEqual(
    { kind: state.routes[0].kind, path: state.routes[0].path },
    { kind: 'exact', path: '/favicon.svg' },
  )
})

test('unloading the plugin releases the route', () => {
  const { ctx, state } = fakeCtx()
  apply(ctx)
  for (const dispose of state.disposers) dispose()
  assert.equal(state.routes.length, 0)
})

test('GET answers the triangle SVG with a revalidating cache policy', () => {
  const { ctx, state } = fakeCtx()
  apply(ctx)
  const res = fakeRes()
  state.routes[0].handler({ method: 'GET' }, res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'image/svg+xml; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-cache, must-revalidate')
  const svg = String(res.body)
  assert.match(svg, /<svg[^>]*viewBox="0 0 50 50"/)
  // One straight-edged triangle, black by default and white under a dark scheme.
  assert.match(svg, /<path[^>]*fill="#000"[^>]*d="M25 [\d.]+ L[\d.]+ [\d.]+ L[\d.]+ [\d.]+ Z"/)
  assert.match(svg, /@media \(prefers-color-scheme: dark\)\s*{\s*path\s*{\s*fill:\s*#fff/)
  assert.equal(Number(res.headers['content-length']), Buffer.byteLength(svg))
})

test('HEAD answers headers only', () => {
  const { ctx, state } = fakeCtx()
  apply(ctx)
  const res = fakeRes()
  state.routes[0].handler({ method: 'HEAD' }, res)
  assert.equal(res.status, 200)
  assert.equal(res.body, undefined)
})

test('other methods are refused without a body', () => {
  const { ctx, state } = fakeCtx()
  apply(ctx)
  const res = fakeRes()
  state.routes[0].handler({ method: 'POST' }, res)
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET, HEAD')
  assert.equal(res.body, undefined)
})
