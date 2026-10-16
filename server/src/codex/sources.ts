import { z } from 'zod'

export const HistorySourceSchema = z.enum([
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
  'unknown',
])

export type HistorySource = z.infer<typeof HistorySourceSchema>
