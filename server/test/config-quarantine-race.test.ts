import Fastify from 'fastify'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ConfigStore } from '../src/config/store.js'
import { configRoutes } from '../src/config/routes.js'
import { WidgetCatalog } from '../src/widgets/catalog.js'

it('a queued layout save cannot restore a connection during credential quarantine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fremkit-quarantine-layout-'))
  const file = join(dir, 'fremkit.json')
  const store = new ConfigStore(file)
  await store.load()
  const connection = { id: 'account-a', type: 'github', name: 'Account', fields: {} }
  await store.update((config) => ({ ...config, connections: [connection] }))
  const staleLayout = structuredClone(store.get())
  const app = Fastify()
  await app.register(configRoutes, { store, catalog: new WidgetCatalog(join(dir, 'widgets')) })
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  try {
    const firstRemoval = store.update(async (config) => {
      entered()
      await gate
      return { ...config, connections: [] }
    })
    await started
    const layoutSave = app.inject({ method: 'PUT', url: '/api/config', payload: staleLayout })
    void layoutSave.then(() => {})
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    await firstRemoval
    expect((await layoutSave).statusCode).toBe(200)
    await store.update((config) => ({ ...config, connections: [] }))
    expect(store.get().connections).toEqual([])
    expect(JSON.parse(await readFile(file + '.bak', 'utf8')).connections).toEqual([])
  } finally {
    release()
    await app.close()
  }
})
