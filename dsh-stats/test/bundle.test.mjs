/**
 * Bundle-contract tests: the built lib/client.js must present the loader
 * envelope, expose the plugin exports, and register the dock entry with a
 * locale namespace that has zh/en parity.
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

/** Stub browser plugin context capturing what the plugin registers. */
function context() {
  const registered = {}
  return {
    registered,
    ctx: {
      effect(fn) {
        return fn()
      },
      locale: {
        register(ns, dictionaries) {
          registered.locale = { ns, dictionaries }
          return () => {}
        },
      },
      slots: {
        inject(key, contribute) {
          registered.seat = key
          registered.dispose = contribute()
          return () => {}
        },
        register(options, Component) {
          registered.options = options
          registered.Component = Component
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
  assert.equal(row.id, 'dsh-stats')
  assert.equal(typeof row.factory, 'function')
  assert.equal(exports.name, 'dsh-stats')
  assert.deepEqual(plain(exports.inject), ['slots', 'locale'])
  assert.equal(typeof exports.apply, 'function')
})

test('injects its stylesheet once and registers the dock entry', () => {
  const { exports, created } = loadBundle()
  const { ctx, registered } = context()
  exports.apply(ctx)
  const style = created.find(element => element.dataset.plugin === 'dsh-stats')
  assert.ok(style, 'a plugin-scoped style element is created')
  assert.match(style.textContent, /dsh-stats-pill/)
  assert.equal(registered.locale.ns, 'dsh-stats')
  assert.equal(registered.seat, 'conversation.composer.dock')
  assert.deepEqual(plain(registered.options), {
    name: 'conversation.composer.dock',
    id: 'dsh-stats',
    order: 1,
    locale: 'dsh-stats',
  })
  assert.equal(typeof registered.Component, 'function')
})

test('ships zh/en dictionaries with identical key sets', () => {
  const { exports } = loadBundle()
  const { ctx, registered } = context()
  exports.apply(ctx)
  const { zh, en } = registered.locale.dictionaries
  assert.deepEqual(Object.keys(plain(zh)).sort(), Object.keys(plain(en)).sort())
})
