import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { DEFAULT_CONFIG } from '../src/config/schema.js'

let dir: string
let app: FastifyInstance
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fremkit-google-integration-'))
  await mkdir(join(dir, 'widgets'))
  await mkdir(join(dir, 'data'))
  await mkdir(join(dir, 'empty-transcripts'))
  await writeFile(join(dir, 'data', 'fremkit.json'), JSON.stringify({ ...DEFAULT_CONFIG, connections: [], secrets: { backend: 'file' } }))
  app = await buildApp({ dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets'), providers: [], claudeTranscriptsDir: join(dir, 'empty-transcripts') })
})
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }) })
const add = (id: string) => app.inject({ method: 'PUT', url: '/api/connections/' + id, payload: { type: 'google', name: id, fields: { clientId: 'example.apps.googleusercontent.com', services: '["gmail","calendar"]', calendarIds: '[]' } } })

describe('Google registration in the assembled application', () => {
  it('offers one Google account with separate Gmail and Calendar channels beside ICS', async () => {
    const types = (await app.inject({ url: '/api/connections/types' })).json()
    const google = types.find((t: { id: string }) => t.id === 'google')
    expect(google?.services).toEqual([{ id: 'gmail', channelPrefix: 'gmail' }, { id: 'google-calendar', channelPrefix: 'google-calendar' }])
    expect(google.fields.filter((f: { secret?: boolean }) => f.secret).map((f: { key: string }) => f.key)).toEqual(['credentials'])
    expect(types.some((t: { id: string }) => t.id === 'ics')).toBe(true)
  })
  it('creates two disconnected accounts without tokens or a browser flow', async () => {
    for (const id of ['account-a', 'account-b']) {
      const saved = await add(id)
      expect(saved.statusCode).toBe(200)
      expect(saved.json().secrets).toEqual({ credentials: false })
      const status = await app.inject({ url: '/api/connections/' + id + '/google' })
      expect(status.statusCode).toBe(200)
      expect(status.json()).toEqual({ state: 'disconnected' })
    }
    const config = (await app.inject({ url: '/api/config' })).json()
    expect(config.connections.map((c: { id: string }) => c.id)).toEqual(['account-a', 'account-b'])
    expect(JSON.stringify(config)).not.toContain('accessToken')
  })
  it('keeps the second account after locally disconnecting the first', async () => {
    expect((await add('account-a')).statusCode).toBe(200)
    expect((await add('account-b')).statusCode).toBe(200)
    const result = await app.inject({ method: 'POST', url: '/api/connections/account-a/google/disconnect', payload: {} })
    expect(result.statusCode).toBe(200)
    expect(result.json()).toEqual({ state: 'disconnected' })
    expect((await app.inject({ url: '/api/connections/account-b/google' })).json()).toEqual({ state: 'disconnected' })
    expect((await app.inject({ url: '/api/connections' })).json().map((c: { id: string }) => c.id).sort()).toEqual(['account-a', 'account-b'])
  })
  it('refuses cross-site Google status reads', async () => {
    expect((await add('account-a')).statusCode).toBe(200)
    const refused = await app.inject({ url: '/api/connections/account-a/google', headers: { origin: 'https://example.com', 'sec-fetch-site': 'cross-site' } })
    expect(refused.statusCode).toBe(403)
  })
  it('rejects widget-chosen authorization URLs before opening anything', async () => {
    expect((await add('account-a')).statusCode).toBe(200)
    const refused = await app.inject({ method: 'POST', url: '/api/connections/account-a/google/connect', payload: { url: 'https://example.com/' } })
    expect(refused.statusCode).toBe(400)
    expect((await app.inject({ url: '/api/connections/account-a/google' })).json()).toEqual({ state: 'disconnected' })
  })
})
