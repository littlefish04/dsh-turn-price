import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// Exercise the plain configuration store, without rendering or mocking a DOM.
function loadInternals() {
  const local = new Map()
  let client
  vm.runInNewContext(source, {
    window: {
      localStorage: {
        getItem: (key) => local.get(key) ?? null,
        setItem: (key, value) => local.set(key, value),
      },
      __ModuleLoader__: {
        load: ({ factory }) => { client = factory(() => ({})) },
      },
    },
  })
  return client.__internals
}

// ConfigFormSnapshot in dsh 0.2.1 has no `mode` property.
function makeForm(value, { status = 'ready', writable = true } = {}) {
  let snapshot = { status, value, writable, base: {}, user: {}, revision: 1 }
  const listeners = new Set()
  const writes = []
  const form = {
    spec: { namespace: 'turn-cost' },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: (patch) => {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener()
    },
    set: async (key, next) => {
      writes.push([key, next])
      form.publish({ value: { ...snapshot.value, [key]: next }, revision: snapshot.revision + 1 })
      return true
    },
    listenerCount: () => listeners.size,
    writes,
  }
  return form
}

function configuredPrices(api, input = 14.2) {
  return {
    ...api.defaultConfig(),
    models: [{
      model: 'gpt-6.1-sol', provider: '', label: 'Configured GPT rate',
      input, cacheRead: 0.71, cacheWrite: 17.75, output: 71,
      rules: [], promos: [],
    }],
  }
}

const route = [{ provider: '12cpa', model: 'gpt-6.1-sol' }]
const buckets = {
  uncachedInputTokens: 440765, outputTokens: 5489,
  cacheReadTokens: 1603840, cacheWriteTokens: 0,
}

function assertGptPrice(api, store) {
  const result = api.computeCost(buckets, route, store.getSnapshot().value, Date.now())
  assert.equal(result.ok, true, 'configured GPT model must not be unknown-model')
  assert.ok(Math.abs(result.total - 7.7873084) < 1e-9)
}

test('initial ready form is subscribed and supplies configured GPT prices without mode', () => {
  const api = loadInternals()
  const form = makeForm(configuredPrices(api))
  const store = api.createStore(form)
  assert.equal(form.listenerCount(), 1)
  assert.equal(store.getSnapshot().source, 'host')
  assertGptPrice(api, store)
  const before = store.getSnapshot()
  assert.equal(store.getSnapshot(), before, 'snapshot identity stays stable until an update')
  form.publish({ value: configuredPrices(api, 20) })
  assert.notEqual(store.getSnapshot(), before)
  assert.equal(store.getSnapshot().value.models[0].input, 20)
  store.dispose()
  assert.equal(form.listenerCount(), 0)
})

test('initial loading form switches to host prices when ready', () => {
  const api = loadInternals()
  const form = makeForm(undefined, { status: 'loading', writable: false })
  const store = api.createStore(form)
  let changes = 0
  store.subscribe(() => { changes += 1 })
  form.publish({ status: 'ready', writable: true, value: configuredPrices(api) })
  assert.equal(changes, 1)
  assert.equal(store.getSnapshot().source, 'host')
  assertGptPrice(api, store)
  store.dispose()
})

test('late and replacement forms subscribe once and release the old subscription', () => {
  const api = loadInternals()
  const store = api.createStore(null)
  const first = makeForm(configuredPrices(api))
  store.attachForm(first)
  store.attachForm(first)
  assert.equal(first.listenerCount(), 1)
  assertGptPrice(api, store)
  const second = makeForm(configuredPrices(api, 20))
  store.attachForm(second)
  assert.equal(first.listenerCount(), 0)
  assert.equal(second.listenerCount(), 1)
  assert.equal(store.getSnapshot().value.models[0].input, 20)
  store.dispose()
  assert.equal(second.listenerCount(), 0)
})

test('read-only host prices still apply, but writes are refused', async () => {
  const api = loadInternals()
  const form = makeForm(configuredPrices(api), { writable: false })
  const store = api.createStore(form)
  assert.equal(store.getSnapshot().source, 'host')
  assert.equal(store.getSnapshot().writable, false)
  assertGptPrice(api, store)
  assert.equal(await store.save(configuredPrices(api, 20)), false)
  assert.equal(form.writes.length, 0)
  assert.equal(store.getSnapshot().value.models[0].input, 14.2)
  store.dispose()
})

test('saving a ready writable form persists through the host', async () => {
  const api = loadInternals()
  const form = makeForm(configuredPrices(api))
  const store = api.createStore(form)
  assert.equal(await store.save(configuredPrices(api, 20)), true)
  assert.ok(form.writes.some(([key]) => key === 'models'))
  assert.equal(form.getSnapshot().value.models[0].input, 20)
  store.dispose()
})

test('local fallback remains usable, but a ready host replaces stale local prices', async () => {
  const api = loadInternals()
  const store = api.createStore(null)
  assert.equal(store.getSnapshot().source, 'local')
  assert.equal(await store.save(configuredPrices(api, 1)), true)
  assert.equal(store.getSnapshot().value.models[0].input, 1)
  const form = makeForm(configuredPrices(api))
  store.attachForm(form)
  assertGptPrice(api, store)
  form.publish({ status: 'unavailable' })
  assert.equal(store.getSnapshot().source, 'local')
  assert.equal(store.getSnapshot().value.models[0].input, 1)
  store.dispose()
})
