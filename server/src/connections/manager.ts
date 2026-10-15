import { createHash } from 'node:crypto'
import type { Connection } from '../config/schema.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { SecretStore } from '../secrets/index.js'
import type { ConnectionTypeRegistry } from './registry.js'
import type { ConnectionAccount, ConnectionCredentials, ConnectionProviderContext } from './types.js'

export interface ConnectionManagerDeps {
  registry: ProviderRegistry
  types: ConnectionTypeRegistry
  secrets: SecretStore
}

/** Persisted absence is the safe recovery state while a form writes several secret items. */
export interface ConnectionConfigTransaction {
  quarantine(): Promise<unknown>
  /** Recovery may need to quarantine a row whose ownership changed during a secret write. */
  quarantineRollback?(): Promise<unknown>
  commit(): Promise<unknown>
  rollback(): Promise<unknown>
}

interface Generation {
  signature: string
  channels: string[]
  abort: AbortController
}

/** Serializes config and secret mutations; a generation owns every service of one account. */
export class ConnectionManager {
  private active = new Map<string, Generation>()
  /** A failed batch requires explicit replacement of every affected key before services resume. */
  private failedSecrets = new Map<string, Set<string>>()
  private queue: Promise<unknown> = Promise.resolve()
  private syncRevision = 0

  constructor(private readonly deps: ConnectionManagerDeps) {}

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  /** Service channels are explicit: a multi-service account has no implicit default service. */
  channelFor(connection: Connection, serviceId?: string): string {
    const type = this.deps.types.get(connection.type)
    if (type?.services) {
      const service = type.services.find((s) => s.id === serviceId)
      if (!service) throw new Error('unknown connection service')
      return service.channelPrefix + ':' + connection.id
    }
    if (serviceId !== undefined) throw new Error('unknown connection service')
    return (type?.channelPrefix ?? connection.type) + ':' + connection.id
  }

  channelsFor(connection: Connection): { serviceId?: string; channel: string }[] {
    const type = this.deps.types.get(connection.type)
    if (type?.services) return type.services.map((s) => ({ serviceId: s.id, channel: this.channelFor(connection, s.id) }))
    return type?.createProvider ? [{ channel: this.channelFor(connection) }] : []
  }

  async secretsFor(connection: Connection): Promise<Record<string, string>> {
    const type = this.deps.types.get(connection.type)
    if (!type) return {}
    const out: Record<string, string> = {}
    for (const key of this.deps.types.secretKeys(type)) {
      const value = await this.deps.secrets.get(connection.id + '/' + key)
      if (value !== null) out[key] = value
    }
    return out
  }

  private retire(id: string, preserveSubscribers = false): void {
    const generation = this.active.get(id)
    if (!generation) return
    generation.abort.abort()
    for (const channel of generation.channels) {
      if (preserveSubscribers) this.deps.registry.suspend(channel)
      else this.deps.registry.unregister(channel)
    }
    // A suspended generation still owns its registered channels. A later removal must
    // unregister them even if credential repair never succeeds.
    if (!preserveSubscribers) this.active.delete(id)
  }

  private async forgetNow(connection: Connection): Promise<void> {
    this.retire(connection.id)
    const type = this.deps.types.get(connection.type)
    for (const key of type ? this.deps.types.secretKeys(type) : []) {
      await this.deps.secrets.delete(connection.id + '/' + key)
    }
    this.failedSecrets.delete(connection.id)
  }

  async forget(connection: Connection): Promise<void> {
    return this.enqueue(() => this.forgetNow(connection))
  }

  /** Validation, persisted removal and credential retirement form one queued mutation. */
  async removeConnection(remove: () => Promise<Connection>, current: () => Connection[]): Promise<void> {
    return this.enqueue(async () => {
      try {
        const connection = await remove()
        await this.forgetNow(connection)
      } finally {
        // Discard snapshots queued by this transaction's config listeners. Read the current
        // config inside the queue, including when persistence or credential deletion failed.
        ++this.syncRevision
        await this.syncNow(structuredClone(current()))
      }
    })
  }

  async sync(connections: Connection[]): Promise<void> {
    const snapshot = structuredClone(connections)
    const revision = ++this.syncRevision
    // Config transactions emit intermediate quarantine states. Only the last queued snapshot
    // becomes active; an already-running sync still completes before its successor.
    return this.enqueue(() => revision === this.syncRevision ? this.syncNow(snapshot) : Promise.resolve())
  }

  /** Opaque identity, distinct after every retirement including A-B-A edits. */
  captureGeneration(id: string): AbortSignal {
    const generation = this.active.get(id)
    if (!generation || generation.abort.signal.aborted) throw new Error('connection retired')
    return generation.abort.signal
  }

  /** OAuth uses the same durable quarantine and rollback as ordinary connection writes. */
  updateSecretsIfCurrent(connection: Connection, expected: AbortSignal, submitted: Record<string, string>,
    config: ConnectionConfigTransaction, isCurrent: () => boolean): Promise<void> {
    return this.updateSecrets(connection, submitted, config, () => {
      if (expected.aborted || this.active.get(connection.id)?.abort.signal !== expected || !isCurrent()) throw new Error('connection retired')
    }, () => {
      // This transaction retired its own generation. Keep checking identity and consent,
      // but do not mistake that intentional retirement for external cancellation.
      if (this.active.get(connection.id)?.abort.signal !== expected || !isCurrent()) throw new Error('connection retired')
    })
  }

  /** Route writes share the mutation queue with provider writes and generation replacement. */
  async updateSecrets(connection: Connection, submitted: Record<string, string>, config?: ConnectionConfigTransaction, guard?: () => void, mutationGuard?: () => void): Promise<void> {
    const values = { ...submitted }
    return this.enqueue(async () => {
      guard?.()
      const type = this.deps.types.get(connection.type)
      if (!type || Object.keys(values).some((key) => !this.deps.types.secretKeys(type).includes(key))) {
        throw new Error('unknown connection secret')
      }
      if ([...(this.failedSecrets.get(connection.id) ?? [])].some((key) => !(key in values))) {
        throw new Error('connection credentials require replacement')
      }
      if (!Object.keys(values).length && !config) return
      const generation = this.active.get(connection.id)
      const original = new Map<string, string | null>()
      for (const key of Object.keys(values)) original.set(key, await this.deps.secrets.get(connection.id + '/' + key))
      guard?.()
      generation?.abort.abort()
      for (const channel of generation?.channels ?? []) this.deps.registry.suspend(channel)
      // Persist absence before the first secret mutation, including in the config backup.
      // A process restarted halfway through the batch therefore cannot create a provider.
      let secretMutationStarted = false
      try {
        mutationGuard?.()
        await config?.quarantine()
        mutationGuard?.()
        for (const [key, value] of Object.entries(values)) {
          secretMutationStarted = true
          if (value === '') await this.deps.secrets.delete(connection.id + '/' + key)
          else await this.deps.secrets.set(connection.id + '/' + key, value)
          mutationGuard?.()
        }
        await config?.commit()
        mutationGuard?.()
      } catch (error) {
        if (!secretMutationStarted) {
          try { await config?.rollback() }
          catch { this.failedSecrets.set(connection.id, new Set(Object.keys(values))) }
          throw error
        }
        this.failedSecrets.set(connection.id, new Set(Object.keys(values)))
        if (config) {
          try {
            // Commit may have persisted before a config listener failed. Re-establish durable
            // absence before restoring any old secret, including during an interrupted rollback.
            await (config.quarantineRollback ? config.quarantineRollback() : config.quarantine())
            for (const [key, value] of original) {
              if (value === null) await this.deps.secrets.delete(connection.id + '/' + key)
              else await this.deps.secrets.set(connection.id + '/' + key, value)
            }
            await config.rollback()
            this.failedSecrets.delete(connection.id)
          } catch {
            // Never restore a binding to secrets whose rollback could not be confirmed.
            await (config.quarantineRollback ? config.quarantineRollback() : config.quarantine())
          }
        }
        throw error
      }
      this.failedSecrets.delete(connection.id)
    })
  }

  private async syncNow(connections: Connection[]): Promise<void> {
    const wanted = new Set(connections.map((c) => c.id))
    // Quarantine removes the binding from config until its credentials are repaired.
    // Keep the suspended channel's subscribers so the existing widgets resume on repair.
    for (const id of this.active.keys()) if (!wanted.has(id)) this.retire(id, this.failedSecrets.has(id))
    for (const connection of connections) {
      if (this.failedSecrets.has(connection.id)) continue
      const type = this.deps.types.get(connection.type)
      if (!type?.createProvider && !type?.services) { this.retire(connection.id); continue }
      const channels = this.channelsFor(connection)
      const secrets = await this.secretsFor(connection)
      const signature = this.signature(connection, secrets)
      const previous = this.active.get(connection.id)
      if (previous && !previous.abort.signal.aborted && previous.signature === signature && JSON.stringify(previous.channels) === JSON.stringify(channels.map((c) => c.channel))) continue
      const generation: Generation = { signature, channels: channels.map((c) => c.channel), abort: new AbortController() }
      const live = () => !generation.abort.signal.aborted && this.active.get(connection.id) === generation
      const assertLive = () => { if (!live()) throw new Error('connection retired') }
      let revision = 0
      let refreshing: Promise<ConnectionCredentials> | undefined
      const snapshot = (): ConnectionCredentials => ({ revision, secrets: Object.freeze({ ...secrets }) })
      const changed = () => { revision++; generation.signature = this.signature(connection, secrets) }
      const account: ConnectionAccount = {
        signal: generation.abort.signal,
        request: async (operation) => {
          assertLive()
          const result = await operation(snapshot(), generation.abort.signal)
          assertLive()
          return result
        },
        refresh: async (observedRevision, exchange) => {
          assertLive()
          if (observedRevision < revision) return snapshot()
          if (observedRevision !== revision) throw new Error('invalid credential revision')
          if (refreshing) return refreshing
          refreshing = Promise.resolve().then(() => {
            assertLive()
            return exchange(snapshot(), generation.abort.signal)
          }).then((replacement) => this.enqueue(async () => {
            assertLive()
            if (observedRevision !== revision) return snapshot()
            if (Object.keys(replacement).some((key) => !this.deps.types.secretKeys(type).includes(key))) {
              throw new Error('unknown connection secret')
            }
            if (Object.keys(replacement).length !== 1) throw new Error('refresh requires one credential bundle')
            try {
              for (const [key, value] of Object.entries(replacement)) {
                await this.deps.secrets.set(connection.id + '/' + key, value)
              }
            } catch (error) {
              // A partial store failure cannot leave services using mixed credentials.
              this.failedSecrets.set(connection.id, new Set(Object.keys(replacement)))
              this.retire(connection.id, true)
              throw error
            }
            Object.assign(secrets, replacement)
            changed()
            return snapshot()
          })).finally(() => { refreshing = undefined })
          return refreshing
        },
      }
      const context = (channel: string): ConnectionProviderContext => ({
        id: connection.id, channel, fields: { ...connection.fields }, secrets,
        saveSecret: (fieldKey, value) => this.enqueue(async () => {
          if (!live() || !this.deps.types.secretKeys(type).includes(fieldKey)) return
          await this.deps.secrets.set(connection.id + '/' + fieldKey, value)
          secrets[fieldKey] = value
          changed()
        }),
        forgetSecret: (fieldKey) => this.enqueue(async () => {
          if (!live() || !this.deps.types.secretKeys(type).includes(fieldKey)) return
          await this.deps.secrets.delete(connection.id + '/' + fieldKey)
          delete secrets[fieldKey]
          changed()
        }),
      })
      try {
        const providers = channels.map(({ channel, serviceId }) => {
          const provider = serviceId === undefined ? type.createProvider!(context(channel))
            : type.services!.find((s) => s.id === serviceId)!.createProvider({ ...context(channel), serviceId, account })
          if (provider.channel !== channel) throw new Error('unexpected connection service channel')
          return provider
        })
        previous?.abort.abort()
        this.active.set(connection.id, generation)
        for (const channel of previous?.channels ?? []) {
          if (!generation.channels.includes(channel)) this.deps.registry.unregister(channel)
        }
        for (const provider of providers) this.deps.registry.register(provider)
      } catch (error) {
        generation.abort.abort()
        this.retire(connection.id)
        throw error
      }
    }
  }

  private signature(connection: Connection, secrets: Record<string, string>): string {
    const digest = createHash('sha256')
    for (const key of Object.keys(secrets).sort()) digest.update(JSON.stringify([key, secrets[key]]))
    const fields = JSON.stringify(Object.keys(connection.fields).sort().map((k) => [k, connection.fields[k]]))
    return connection.type + '|' + fields + '|' + digest.digest('hex')
  }
}
