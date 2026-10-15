import { describe, it, expect } from 'vitest'
import { withAccountEmail } from '../src/privacy.js'
import { ConfigSchema, DEFAULT_CONFIG } from '../src/config/schema.js'

describe('withAccountEmail', () => {
  const snapshot = (show: boolean) => ({ plan: 'max', authMode: 'oauth', ...withAccountEmail('someone@example.com', show) })

  it('leaves the address out of the snapshot when the setting is off', () => {
    const s = snapshot(false)
    expect(s).not.toHaveProperty('email')
    // Not an empty or masked value either: the key is absent, so nothing reaches a widget.
    expect(JSON.stringify(s)).not.toContain('example.com')
  })

  it('keeps the plan and the sign-in method whatever the setting', () => {
    expect(snapshot(false)).toEqual({ plan: 'max', authMode: 'oauth' })
    expect(snapshot(true)).toEqual({ plan: 'max', authMode: 'oauth', email: 'someone@example.com' })
  })

  it('publishes nothing when there is no address to publish', () => {
    expect(withAccountEmail(null, true)).toEqual({})
    expect(withAccountEmail(undefined, true)).toEqual({})
    expect(withAccountEmail('', true)).toEqual({})
  })

  it('is off on a fresh install', () => {
    expect(DEFAULT_CONFIG.privacy.showAccountEmail).toBe(false)
    expect(ConfigSchema.shape.privacy.parse(undefined).showAccountEmail).toBe(false)
  })
})
