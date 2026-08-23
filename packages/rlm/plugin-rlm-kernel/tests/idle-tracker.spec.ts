/**
 * Unit tests for the idle-kernel reclamation bookkeeping (item-4). The pure
 * `IdleTracker` decides which sessions have been idle too long; the registry's
 * `disposeIdle` layers on that decision without needing a real kernel here.
 */
import { describe, expect, it } from 'vitest'
import { IdleTracker } from '../src/kernels.ts'

function tracker(timeoutMs: number, now = () => 1_000_000) {
  return new IdleTracker(timeoutMs, now)
}

describe('IdleTracker', () => {
  it('never expires a never-touched id', () => {
    const t = tracker(10_000)
    expect(t.expired(['a'], new Set())).toEqual([])
  })

  it('expires only ids idle beyond the timeout', () => {
    let now = 1_000_000
    const t = tracker(10_000, () => now)
    t.touch('a')
    t.touch('b')
    now += 5_000
    expect(t.expired(['a', 'b'], new Set())).toEqual([])
    now += 6_000 // total idle 11s > 10s
    expect(t.expired(['a', 'b'], new Set())).toEqual(['a', 'b'])
  })

  it('touch resets the clock', () => {
    let now = 1_000_000
    const t = tracker(10_000, () => now)
    t.touch('a')
    now += 11_000
    expect(t.expired(['a'], new Set())).toEqual(['a'])
    t.touch('a')
    expect(t.expired(['a'], new Set())).toEqual([])
    now += 11_000
    expect(t.expired(['a'], new Set())).toEqual(['a'])
  })

  it('never expires a busy id, even past the timeout', () => {
    let now = 1_000_000
    const t = tracker(10_000, () => now)
    t.touch('a')
    now += 60_000
    expect(t.expired(['a'], new Set(['a']))).toEqual([])
    expect(t.expired(['a'], new Set())).toEqual(['a'])
  })

  it('remove clears the idle record', () => {
    let now = 1_000_000
    const t = tracker(10_000, () => now)
    t.touch('a')
    t.remove('a')
    now += 60_000
    expect(t.expired(['a'], new Set())).toEqual([])
  })

  it('a non-positive timeout disables reclamation', () => {
    const t = tracker(0)
    t.touch('a')
    expect(t.expired(['a'], new Set())).toEqual([])
  })
})
