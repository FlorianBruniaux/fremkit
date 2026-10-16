import { z } from 'zod'
import type { CodexFailure } from './adapter.js'
import type { HistorySource } from './sources.js'
const metric = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .nullish()
  .transform((v) => v ?? null)
const window = z
  .object({
    usedPercent: z.number().int().nonnegative(),
    windowDurationMins: metric,
    resetsAt: metric,
  })
  .transform((v) => ({
    ...v,
    remainingPercent: Math.max(0, Math.min(100, 100 - v.usedPercent)),
  }))
const bucket = z.object({
  limitId: z.string().max(200).nullish(),
  limitName: z.string().max(200).nullish(),
  primary: window.nullish().transform((v) => v ?? null),
  secondary: window.nullish().transform((v) => v ?? null),
})
export const QuotasSchema = z
  .object({
    rateLimits: bucket,
    rateLimitsByLimitId: z.record(z.string(), bucket).nullish(),
    accountId: z.string().nullish(),
  })
  .transform((v) => {
    const multi =
      v.rateLimitsByLimitId && Object.keys(v.rateLimitsByLimitId).length
        ? Object.entries(v.rateLimitsByLimitId).slice(0, 50)
        : [[v.rateLimits.limitId ?? 'codex', v.rateLimits] as const]
    return {
      buckets: multi.map(([id, b]) => ({
        id,
        name: b.limitName ?? null,
        primary: b.primary,
        secondary: b.secondary,
      })),
    }
  })
export const UsageSchema = z.object({
  summary: z.object({
    lifetimeTokens: metric,
    peakDailyTokens: metric,
    currentStreakDays: metric,
    longestStreakDays: metric,
    longestRunningTurnSec: metric,
  }),
  dailyUsageBuckets: z
    .array(
      z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .max(3660)
    .nullish()
    .transform((v) => v ?? null),
})
export const AccountSchema = z.object({
  requiresOpenaiAuth: z.boolean(),
  account: z
    .object({
      type: z.enum(['chatgpt', 'apiKey', 'amazonBedrock']),
      email: z.string().max(320).nullish(),
      planType: z.string().max(100).nullish(),
    })
    .nullish(),
  workspaceRouting: z.object({ chatgptAccountId: z.string() }).nullish(),
})
export const ThreadIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
export const HistorySchema = z.object({
  data: z
    .array(
      z.object({
        id: ThreadIdSchema,
        name: z.string().max(2000).nullish(),
        source: z.union([z.string(), z.record(z.string(), z.unknown())]),
        createdAt: z.number().int().nonnegative(),
        updatedAt: z.number().int().nonnegative(),
        ephemeral: z.boolean(),
      }),
    )
    .max(50),
  nextCursor: z.string().max(4000).nullish(),
})
export interface Quotas {
  buckets: { id: string; name: string | null; primary: QuotaWindow | null; secondary: QuotaWindow | null }[]
}
export interface QuotaWindow {
  usedPercent: number
  remainingPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}
export type Usage = z.infer<typeof UsageSchema>
export interface HistoryThread {
  id: string
  title: string | null
  sourceKind: HistorySource
  createdAt: number
  updatedAt: number
  liveActivity: null
  navigation: 'localChat' | 'unavailable'
}
export interface History {
  threads: HistoryThread[]
  nextCursor: string | null
  truncated: boolean
}
export interface SnapshotPart<T> {
  data: T | null
  updatedAt: number | null
  freshness: 'fresh' | 'stale' | 'unavailable'
  error: CodexFailure | null
}
export interface CodexAccount {
  type: 'chatgpt' | 'apiKey' | 'amazonBedrock'
  planType: string | null
}
export interface CodexSnapshot {
  sourceKind: 'localAppServer'
  authMode: 'chatgpt' | 'apiKey' | 'amazonBedrock' | null
  account: SnapshotPart<CodexAccount>
  quotas: SnapshotPart<Quotas>
  usage: SnapshotPart<Usage>
  history: SnapshotPart<History>
  checkedAt: number | null
  error: CodexFailure | null
}
export const emptyPart = <T>(error: CodexFailure = 'unconfigured'): SnapshotPart<T> => ({
  data: null,
  updatedAt: null,
  freshness: 'unavailable',
  error,
})
export const emptySnapshot = (error: CodexFailure = 'unconfigured'): CodexSnapshot => ({
  sourceKind: 'localAppServer',
  authMode: null,
  account: emptyPart(error),
  quotas: emptyPart(error),
  usage: emptyPart(error),
  history: emptyPart(error),
  checkedAt: null,
  error,
})
