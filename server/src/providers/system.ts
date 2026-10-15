import si from 'systeminformation'
import { uptime } from 'node:os'
import type { Provider } from './types.js'
import { createMacTemperatureReader } from './mac-thermals.js'

const round = (n: number) => Math.round(n * 10) / 10

interface DiskReading {
  mount: string
  size: number
  used: number
  available?: number
  use: number
}

/** APFS shares capacity: the data volume represents the useful Mac disk. */
export function normalizeDisks(disks: DiskReading[]) {
  const data = disks.find((disk) => disk.mount === '/System/Volumes/Data')
  return disks
    .filter((disk) => (data ? disk === data : disk.mount === '/')
      || disk.mount.startsWith('/Volumes/'))
    .map((disk) => {
      const available = typeof disk.available === 'number'
        && Number.isFinite(disk.available) && disk.available >= 0
        ? disk.available : null
      const isMacDisk = disk === data
      const used = isMacDisk && available !== null ? Math.max(0, disk.size - available) : disk.used
      return {
        mount: isMacDisk ? '/' : disk.mount,
        size: disk.size,
        used,
        available,
        use: round(isMacDisk && available !== null && disk.size > 0
          ? used / disk.size * 100 : disk.use),
      }
    })
}

/** A denied uptime reading must not suppress CPU, memory or disk metrics. */
function uptimeSeconds(): number | null {
  try {
    const seconds = uptime()
    return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : null
  } catch {
    return null
  }
}

export function createSystemProvider(options: {
  macmonTemperatureEnabled?: () => boolean
  readMacTemperature?: ReturnType<typeof createMacTemperatureReader>
} = {}): Provider {
  const readMacTemperature = options.readMacTemperature ?? createMacTemperatureReader()
  return {
    channel: 'system',
    intervalMs: 2000,
    async poll() {
      const [load, mem, fs, net, temp] = await Promise.all([
        si.currentLoad(), si.mem(), si.fsSize(), si.networkStats(), si.cpuTemperature(),
      ])
      const measured = options.macmonTemperatureEnabled?.() ? readMacTemperature() : null
      const macmonTemp = measured?.cpuCelsius ?? null
      const systemTemp = temp.main > 0 ? round(temp.main) : null
      return {
        uptimeSeconds: uptimeSeconds(),
        cpu: {
          load: round(load.currentLoad),
          cores: load.cpus.map((c) => round(c.load)),
          temp: macmonTemp ?? systemTemp,
          tempSource: macmonTemp !== null ? 'macmon' : systemTemp !== null ? 'system' : null,
          tempError: measured?.error ?? null,
        },
        memory: {
          total: mem.total,
          used: mem.active,
          free: mem.available,
          swapUsed: mem.swapused,
          swapTotal: mem.swaptotal,
        },
        disks: normalizeDisks(fs),
        network: net.map((n) => ({
          iface: n.iface,
          rx: Math.max(0, Math.round(n.rx_sec ?? 0)),
          tx: Math.max(0, Math.round(n.tx_sec ?? 0)),
        })),
      }
    },
  }
}

export const systemProvider = createSystemProvider()
