import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createYouTubeBridge, localSdp, youtubeUrl } from '../src/youtube/bridge.js'

const origin = 'chrome-extension://' + 'a'.repeat(32)
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function bridge(now: () => number = Date.now) {
  const dataDir = await mkdtemp(join(tmpdir(), 'fremkit-youtube-'))
  dirs.push(dataDir)
  const result = await createYouTubeBridge({ dataDir, port: 4243, now })
  return { ...result, dataDir }
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
      const saved = JSON.parse(await readFile(join(b.dataDir, 'youtube-pairing.json'), 'utf8'))
      expect(saved.origin).toBe(origin)
      expect((await stat(join(b.dataDir, 'youtube-pairing.json'))).mode & 0o777).toBe(0o600)
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
})
