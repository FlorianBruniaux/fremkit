import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ThreadIdSchema } from './snapshot.js'

export interface LocalChatValidator {
  (threadId: string): Promise<boolean>
  validateMany?: (threadIds: string[]) => Promise<Set<string>>
}

/** Desktop-owned catalog membership, independent of source, title and thread status. */
export function createLocalChatValidator(options: { databasePath?: string } = {}): LocalChatValidator {
  const databasePath = options.databasePath ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sqlite', 'codex-dev.db')
  const validateMany = async (threadIds: string[]): Promise<Set<string>> => {
    const ids = [...new Set(threadIds.filter(id => ThreadIdSchema.safeParse(id).success))].slice(0, 50)
    if (!ids.length) return new Set()
    // UUID validation excludes SQL delimiters. The child sees one bounded page, not thread content.
    const quoted = ids.map(id => `'${id}'`).join(',')
    const query = `SELECT DISTINCT t.thread_id AS id FROM local_thread_catalog AS t
      JOIN local_thread_catalog_hosts AS h ON h.host_id=t.host_id
      WHERE t.host_id='local' AND h.host_kind='local' AND t.missing_candidate=0
      AND t.thread_id IN (${quoted});`
    return new Promise(resolve => {
      execFile('/usr/bin/sqlite3', ['-readonly', '-json', '-batch', '-cmd', 'PRAGMA query_only=ON;', '-cmd', '.timeout 1000', databasePath, query],
        { timeout: 2000, maxBuffer: 8192, shell: false }, (error, stdout) => {
          if (error) return resolve(new Set())
          try {
            const rows: unknown = JSON.parse(stdout || '[]')
            if (!Array.isArray(rows)) return resolve(new Set())
            resolve(new Set(rows.flatMap(row => row && typeof row === 'object' && 'id' in row && typeof row.id === 'string' && ids.includes(row.id) ? [row.id] : [])))
          } catch { resolve(new Set()) }
        })
    })
  }
  const validate: LocalChatValidator = async id => (await validateMany([id])).has(id)
  validate.validateMany = validateMany
  return validate
}
