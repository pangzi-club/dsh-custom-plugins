/**
 * Bundle-contract tests: the built lib/client.js must present the loader
 * envelope, expose the plugin exports, register the three seats and the
 * resource provider, and ship a locale namespace with zh/en parity.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

/** Stub of the baseline platform modules the bundle requires. */
function platformModules() {
  return {
    'react': {
      createElement: () => null,
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
      useRef: (initial) => ({ current: initial ?? null }),
      useMemo: (factory) => factory(),
      useCallback: (callback) => callback,
      Fragment: Symbol('Fragment'),
    },
    'react-dom': { createPortal: () => null },
    '@deepseek-ai/dsh-client-ui-primitives': {
      useAnchoredPosition: () => null,
      useDismissOnOutsidePointer: () => {},
      useAnchoredMaxHeight: () => 0,
      Menu: () => null,
      Modal: () => null,
      Toast: () => null,
      StateDot: () => null,
    },
  }
}

/** Execute the built bundle and return the factory it registers. */
function loadBundle() {
  let row
  const created = []
  const document = {
    querySelector: () => null,
    createElement: () => {
      const element = { dataset: {}, textContent: '' }
      created.push(element)
      return element
    },
    head: { appendChild: () => {} },
  }
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: value => { row = value } } },
    document,
    console,
  })
  vm.runInContext(readFileSync(BUNDLE, 'utf8'), context)
  assert.ok(row, 'the bundle registers a module-loader row')
  const registry = platformModules()
  const exports = row.factory(specifier => {
    if (specifier in registry) return registry[specifier]
    throw new Error(`the bundle requested an unknown module ${specifier}`)
  })
  return { row, exports, created }
}

/**
 * Stub browser plugin context capturing what the plugin registers. The slots
 * stub follows the framework contract: `inject` calls its contribute callback
 * (which itself calls `register`), so capture happens inside `register` for
 * whichever seat is currently being contributed.
 */
function context() {
  const registered = { effects: [], seats: [] }
  let current = null
  return {
    registered,
    ctx: {
      effect(fn, label) {
        registered.effects.push({ dispose: fn(), label })
      },
      locale: {
        register(ns, dictionaries) {
          registered.locale = { ns, dictionaries }
          return () => {}
        },
      },
      resources: {
        register(provider) {
          registered.provider = provider
          return () => {}
        },
      },
      slots: {
        inject(key, contribute) {
          const captured = { seat: key }
          current = captured
          captured.dispose = contribute()
          current = null
          registered.seats.push(captured)
          return () => {}
        },
        register(options, Component) {
          if (current !== null) {
            current.options = options
            current.Component = Component
          }
          return () => {}
        },
      },
    },
  }
}

/** Copy a value out of the vm realm so structural assertions compare plainly. */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

test('presents the loader envelope with the package identity', () => {
  const { row, exports } = loadBundle()
  assert.equal(row.id, 'dsh-tool-watchtower')
  assert.equal(typeof row.factory, 'function')
  assert.equal(exports.name, 'dsh-tool-watchtower')
  assert.deepEqual(plain(exports.inject), ['slots', 'locale', 'resources'])
  assert.equal(typeof exports.apply, 'function')
})

test('injects its stylesheet once and registers locale, provider, and three seats', () => {
  const { exports, created } = loadBundle()
  const { ctx, registered } = context()
  exports.apply(ctx)

  const style = created.find(element => element.dataset.plugin === 'dsh-tool-watchtower')
  assert.ok(style, 'a plugin-scoped style element is created')
  assert.match(style.textContent, /dsh-tower-pill/)
  assert.equal(registered.locale.ns, 'dsh-tool-watchtower')

  assert.equal(registered.provider.protocol, 'dsh-tool-watchtower')
  assert.equal(typeof registered.provider.open, 'function')
  assert.ok(registered.effects.length >= 2, 'locale and provider ride ctx.effect')

  assert.deepEqual(registered.seats.map(seat => seat.seat), [
    'conversation.composer.dock',
    'conversation.session.header.utilities',
    'tool.call.toolview',
  ])
  assert.ok(registered.seats.every(seat => typeof seat.Component === 'function'))
  assert.deepEqual(plain(registered.seats[0].options), {
    name: 'conversation.composer.dock',
    id: 'dsh-tool-watchtower',
    order: 1,
    locale: 'dsh-tool-watchtower',
  })
  assert.deepEqual(plain(registered.seats[2].options), { name: 'tool.call.toolview', key: 'watchtower_report' })
})

test('ships zh/en dictionaries with identical key sets', () => {
  const { exports } = loadBundle()
  const { ctx, registered } = context()
  exports.apply(ctx)
  const { zh, en } = registered.locale.dictionaries
  assert.deepEqual(Object.keys(plain(zh)).sort(), Object.keys(plain(en)).sort())
})
