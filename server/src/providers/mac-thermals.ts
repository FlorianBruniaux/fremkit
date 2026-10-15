import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export interface MacTemperature {
  cpuCelsius: number | null
  updatedAt: number | null
  error: 'unconfigured' | 'offline' | 'invalid' | 'unsupported' | null
}

const unknown = (error: MacTemperature['error']): MacTemperature => ({ cpuCelsius: null, updatedAt: null, error })
const exec = promisify(execFile)
type Runner = (file: string, args: string[]) => Promise<string>
const run: Runner = async (file, args) => (await exec(file, args, { timeout: 4000, maxBuffer: 64 * 1024, encoding: 'utf8' })).stdout

/** Accept only a recent bounded sensor reading, never an estimate from CPU load. */
export function parseMacTemperature(output: string, now: number): MacTemperature {
  try {
    const data = JSON.parse(output.trim())
    const updatedAt = typeof data?.timestamp === 'string' ? Date.parse(data.timestamp) : NaN
    const value = data?.temp?.cpu_temp_avg
    if (!Number.isFinite(updatedAt) || now - updatedAt > 30_000 || updatedAt - now > 5_000) return unknown('invalid')
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 150) return unknown('invalid')
    return { cpuCelsius: Math.round(value * 10) / 10, updatedAt, error: null }
  } catch { return unknown('invalid') }
}

/** Return the last reading immediately. A bounded macmon refresh runs in the background. */
export function createMacTemperatureReader(options: { run?: Runner; now?: () => number; platform?: string; arch?: string } = {}) {
  const execute = options.run ?? run
  const now = options.now ?? Date.now
  const supported = (options.platform ?? process.platform) === 'darwin' && (options.arch ?? process.arch) === 'arm64'
  let cached = unknown('unconfigured')
  let checkedAt = -Infinity
  let pending: Promise<void> | null = null
  function failed(error: MacTemperature['error']): void {
    // Keep the last valid sample until it expires, even when one refresh fails.
    cached = cached.cpuCelsius !== null && cached.updatedAt !== null
      ? { ...cached, error } : unknown(error)
  }
  async function refresh(): Promise<void> {
    for (const binary of ['/opt/homebrew/bin/macmon', '/usr/local/bin/macmon']) {
      try {
        const sample = parseMacTemperature(await execute(binary, ['pipe', '-s', '1', '-i', '500']), now())
        if (sample.cpuCelsius !== null) cached = sample
        else failed(sample.error)
        checkedAt = now()
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          failed('offline')
          checkedAt = now()
          return
        }
      }
    }
    failed('unconfigured')
    checkedAt = now()
  }
  return (): MacTemperature => {
    if (!supported) return unknown('unsupported')
    if (!pending && now() - checkedAt >= 10_000) {
      pending = refresh().finally(() => { pending = null })
    }
    return cached.updatedAt !== null && now() - cached.updatedAt > 30_000
      ? { ...cached, cpuCelsius: null, error: cached.error ?? 'invalid' } : cached
  }
}
