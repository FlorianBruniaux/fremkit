import { isAbsolute } from 'node:path'
import { z } from 'zod'

/** Optional trusted host override for an installed Codex CLI. */
export const CodexBinarySchema = z.string().min(1).max(4096)
  .refine(isAbsolute).refine(value => !value.includes('\0'))
