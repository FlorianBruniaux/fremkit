import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createYouTubeBridge, localSdp, youtubeUrl } from '../src/youtube/bridge.js'
import { FileSecretStore } from '../src/secrets/file.js'

const origin = 'chrome-extension://' + 'a'.repeat(32)
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function bridge(now: () => number = Date.now) {
  const dataDir = await mkdtemp(join(tmpdir(), 'fremkit-youtube-'))
  dirs.push(dataDir)
  const secrets = new FileSecretStore(join(dataDir, 'secrets.json'))
  const result = await createYouTubeBridge({ dataDir, port: 4243, now, secrets, cleanupIntervalMs: 10 })
  return { ...result, dataDir, secrets }
}

describe('YouTube bridge boundaries', () => {
  it('accepts only direct YouTube video URLs and local ICE candidates', () => {
    expect(youtubeUrl('https://www.youtube.com/watch?v=abcdefghijk')).toBe(true)
    expect(youtubeUrl('https://youtube.com/shorts/abcdefghijk')).toBe(true)
    expect(youtubeUrl('https://evil.example/watch?v=abcdefghijk')).toBe(false)
    expect(youtubeUrl('http://www.youtube.com/watch?v=abcdefghijk')).toBe(false)
    expect(youtubeUrl('https://www.youtube.com/playlist?list=abc')).toBe(false)
    expect(localSdp('v=0\na=candidate:1 1 udp 2122260223 192.168.1.2 53555 typ host')).toBe(true)
    expect(localSdp('v=0\na=candidate:1 1 udp 2122260223 8.8.8.8 53555 typ host')).toBe(false)
    expect(localSdp('v=0\na=candidate:1 1 udp 2122260223 192.168.1.2 53555 typ relay')).toBe(false)
  })

  it('requires a local dashboard command and an allowed extension origin to pair', async () => {
    const b = await bridge()
    try {
      await expect(b.provider.commands!.pair({ instanceId: 'video' }, { loopback: false })).rejects.toThrow('Local dashboard required')
      const issued = await b.provider.commands!.pair({ instanceId: 'video' }, { loopback: true }) as { code: string }
      const payload = { method: 'POST' as const, url: '/pair', headers: { host: '127.0.0.1:4243', origin, 'content-type': 'application/json' }, payload: { code: issued.code } }
      expect((await b.app.inject({ ...payload, headers: { ...payload.headers, origin: 'https://evil.example' } })).statusCode).toBe(403)
      expect((await b.app.inject({ ...payload, headers: { ...payload.headers, host: 'localhost:4243' } })).statusCode).toBe(403)
      expect((await b.app.inject({ ...payload, payload: { code: '000000' } })).statusCode).toBe(403)
      const result = await b.app.inject(payload)
      expect(result.statusCode).toBe(200)
      expect(result.json().token).toMatch(/^[a-f0-9]{64}$/)
      expect((await b.app.inject(payload)).statusCode).toBe(403)
      const saved = JSON.parse((await b.secrets.get('youtube/pairing'))!)
      expect(saved.origin).toBe(origin)
      expect((await stat(join(b.dataDir, 'secrets.json'))).mode & 0o777).toBe(0o600)
      await expect(stat(join(b.dataDir, 'youtube-pairing.json'))).rejects.toMatchObject({code:'ENOENT'})
    } finally { await b.app.close() }
  })

  it('expires a code and rejects commands for absent sessions', async () => {
    let time = 1000
    const b = await bridge(() => time)
    try {
      const issued = await b.provider.commands!.pair({ instanceId: 'video' }, { loopback: true }) as { code: string }
      time += 90001
      const reply = await b.app.inject({ method: 'POST', url: '/pair', headers: { host: '127.0.0.1:4243', origin }, payload: { code: issued.code } })
      expect(reply.statusCode).toBe(403)
      const result = await b.provider.commands!.control({ instanceId: 'video', sessionId: '00000000-0000-4000-8000-000000000001', action: 'toggle' }, { loopback: true })
      expect(result).toEqual({ ok: false })
    } finally { await b.app.close() }
  })

  it('consumes a pairing code before asynchronous storage finishes', async () => {
    const b = await bridge()
    const originalSet = b.secrets.set.bind(b.secrets)
    let entered!: () => void, release!: () => void
    const blocked = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    b.secrets.set = async (key, value) => { entered(); await gate; await originalSet(key, value) }
    try {
      const issued = await b.provider.commands!.pair({ instanceId: 'video' }, { loopback: true }) as { code: string }
      const request = { method: 'POST' as const, url: '/pair', headers: { host: '127.0.0.1:4243', origin }, payload: { code: issued.code } }
      const first = b.app.inject(request)
      await blocked
      expect((await b.app.inject(request)).statusCode).toBe(403)
      release()
      expect((await first).statusCode).toBe(200)
    } finally { release?.(); await b.app.close() }
  })

  it('moves a legacy pairing into the configured secret store', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fremkit-youtube-migrate-'))
    dirs.push(dataDir)
    const secrets = new FileSecretStore(join(dataDir, 'secrets.json'))
    const legacy = { origin, token: 'a'.repeat(64) }
    await writeFile(join(dataDir, 'youtube-pairing.json'), JSON.stringify(legacy), { mode: 0o600 })
    const b = await createYouTubeBridge({ dataDir, port: 4243, secrets })
    try {
      expect(JSON.parse((await secrets.get('youtube/pairing'))!)).toEqual(legacy)
      await expect(stat(join(dataDir, 'youtube-pairing.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await b.app.close() }
  })

  it('keeps the extension connected after an in-flight stop update and expires receivers without polling', async () => {
    let time = 1000
    const b = await bridge(() => time)
    const sessionId = '00000000-0000-4000-8000-000000000001'
    const receiverId = '00000000-0000-4000-8000-000000000002'
    const meta = { title: 'Video', url: 'https://www.youtube.com/watch?v=abcdefghijk', currentTime: 1,
      duration: 120, paused: false, muted: false, volume: 0.5, crop: null }
    let socket: Awaited<ReturnType<typeof b.app.injectWS>> | undefined
    try {
      const issued = await b.provider.commands!.pair({ instanceId: 'video' }, { loopback: true }) as { code: string }
      const paired = await b.app.inject({ method: 'POST', url: '/pair', headers: { host: '127.0.0.1:4243', origin }, payload: { code: issued.code } })
      socket = await b.app.injectWS('/bridge', { headers: { host: '127.0.0.1:4243', origin } })
      const ready = new Promise<void>(resolve => socket!.once('message', () => resolve()))
      socket.send(JSON.stringify({ type: 'hello', token: paired.json().token }))
      await ready
      socket.send(JSON.stringify({ type: 'started', sessionId, meta }))
      await expect.poll(async () => (await b.provider.poll!() as { state: string }).state).toBe('sharing')
      expect(await b.provider.commands!.view({ instanceId: 'video', receiverId, sessionId }, { loopback: true })).toEqual({ ok: true })
      for (const next of [9000, 17000, 25000]) {
        time = next
        socket.send(JSON.stringify({ type: 'metadata', sessionId, meta }))
        await expect.poll(async () => (await b.provider.poll!() as { updatedAt: number }).updatedAt).toBe(next)
      }
      const detached = new Promise<void>(resolve => socket!.on('message', raw => {
        if (JSON.parse(raw.toString()).type === 'detach') resolve()
      }))
      time = 31001
      await Promise.race([detached, new Promise<never>((_, reject) => setTimeout(() => reject(Error('receiver did not expire')), 500))])
      expect(await b.provider.commands!.control({ instanceId: 'video', sessionId, action: 'stop' }, { loopback: true })).toEqual({ ok: true })
      socket.send(JSON.stringify({ type: 'metadata', sessionId, meta }))
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(socket.readyState).toBe(1)
    } finally { socket?.terminate(); await b.app.close() }
  })
})
