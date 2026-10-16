import { describe, expect, it } from 'vitest'
import { normalizeDisks } from '../src/providers/system.js'

describe('Mac disk availability', () => {
  it('prefers APFS Data and reconciles used and available bytes', () => {
    const disks = normalizeDisks([
      { mount: '/', size: 1000, used: 50, available: 300, use: 10 },
      { mount: '/System/Volumes/Data', size: 1000, used: 650, available: 300, use: 68 },
      { mount: '/Volumes/External', size: 500, used: 10, available: 450, use: 2 },
    ])
    expect(disks).toEqual([
      { mount: '/', size: 1000, used: 700, available: 300, use: 70 },
      { mount: '/Volumes/External', size: 500, used: 10, available: 450, use: 2 },
    ])
  })

  it('leaves unreported free space unknown', () => {
    expect(normalizeDisks([{ mount: '/', size: 1000, used: 50, use: 5 }])[0].available).toBeNull()
  })
})
