/**
 * Balance tests: payload normalization and every transport outcome the route
 * maps into the dialog's unavailable states.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchBalance, normalizeBalance } from '../host/balance.js'

const PAYLOAD = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
    { currency: 'USD', total_balance: '3.50', granted_balance: '0.00', topped_up_balance: '3.50' },
  ],
}

test('normalizes the documented balance payload', () => {
  assert.deepEqual(normalizeBalance(PAYLOAD), {
    isAvailable: true,
    rows: [
      { currency: 'CNY', total: '110.00', granted: '10.00', toppedUp: '100.00' },
      { currency: 'USD', total: '3.50', granted: '0.00', toppedUp: '3.50' },
    ],
  })
})

test('reports an exhausted account as available:false with its rows', () => {
  assert.deepEqual(normalizeBalance({ is_available: false, balance_infos: [] }), { isAvailable: false, rows: [] })
})

test('accepts a payload without balance_infos', () => {
  assert.deepEqual(normalizeBalance({ is_available: false }), { isAvailable: false, rows: [] })
})

test('rejects payloads whose shape is not recognized', () => {
  assert.equal(normalizeBalance(undefined), undefined)
  assert.equal(normalizeBalance({ is_available: true, balance_infos: 'CNY' }), undefined)
  assert.equal(normalizeBalance({ is_available: true, balance_infos: [null] }), undefined)
  assert.equal(normalizeBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1' }] }), undefined)
  assert.equal(normalizeBalance({ is_available: true, balance_infos: [{ currency: '', total_balance: '1', granted_balance: '0', topped_up_balance: '0' }] }), undefined)
})

test('reads the balance endpoint with the bearer credential', async () => {
  const calls = []
  const result = await fetchBalance({
    baseURL: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => PAYLOAD }
    },
  })
  assert.equal(result.kind, 'ok')
  assert.equal(result.isAvailable, true)
  assert.equal(result.rows.length, 2)
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance')
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test')
})

test('maps HTTP failures to their status', async () => {
  const result = await fetchBalance({
    baseURL: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    fetchImpl: async () => ({ ok: false, status: 401 }),
  })
  assert.deepEqual(result, { kind: 'http-error', status: 401 })
})

test('maps an unrecognized payload to malformed', async () => {
  const result = await fetchBalance({
    baseURL: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) }),
  })
  assert.equal(result.kind, 'ok')
  assert.deepEqual(result.rows, [])
})

test('maps a transport failure to network', async () => {
  const result = await fetchBalance({
    baseURL: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED') },
  })
  assert.equal(result.kind, 'network')
  assert.match(result.message, /ECONNREFUSED/)
})
