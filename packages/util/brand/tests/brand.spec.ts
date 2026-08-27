/**
 * Unit tests for the `Branded<B>` nominal-typing primitive.
 *
 * The brand is a compile-time-only type construct — it erases to a plain string
 * at runtime. These tests verify that branded types behave as ordinary strings
 * across the runtime operations the harness depends on: comparison, logging,
 * JSON serialization, and Map/Set identity.
 *
 * @module @deepseek-ai/dsh-brand/tests
 */

import { describe, expect, it, expectTypeOf } from 'vitest'
import type { Branded } from '@deepseek-ai/dsh-brand'

// Branded types used across the harness — duplicated here as a pure type check
// so this package's own tests prove the primitive works without a cross-package
// dependency. The concrete factories live in the owning packages.
type SessionId = Branded<'SessionId'>
type CallId = Branded<'CallId'>
type JobId = Branded<'JobId'>

/** Minimal factory that mirrors the owning packages' casts. */
function SessionId(id: string): SessionId { return id as SessionId }
function CallId(id: string): CallId { return id as CallId }
function JobId(id: string): JobId { return id as JobId }

describe('Branded<B> type safety', () => {
  it('produces a string assignable type', () => {
    // A Branded<B> is a string at runtime — it must be assignable to string.
    const sid: SessionId = SessionId('session-abc')
    const str: string = sid
    expect(str).toBe('session-abc')
  })

  it('preserves the raw string value through the factory', () => {
    expect(SessionId('s1')).toBe('s1')
    expect(CallId('c1')).toBe('c1')
    expect(JobId('j1')).toBe('j1')
  })

  it('keeps different brands non-interchangeable at the type level', () => {
    // Compile-time check: the branded types are structurally distinct.
    // A SessionId must not be assignable to a CallId.
    const sid: SessionId = SessionId('s1')
    const callId: CallId = CallId('c1')
    const jobId: JobId = JobId('j1')

    // At runtime they are all strings — this exercises the type-level
    // distinction through a runtime sanity check.
    expectTypeOf(sid).not.toEqualTypeOf<CallId>()
    expectTypeOf(sid).not.toEqualTypeOf<JobId>()
    expectTypeOf(callId).not.toEqualTypeOf<SessionId>()
    expectTypeOf(callId).not.toEqualTypeOf<JobId>()
    expectTypeOf(jobId).not.toEqualTypeOf<SessionId>()
    expectTypeOf(jobId).not.toEqualTypeOf<CallId>()
  })

  it('supports strict equality comparison (===)', () => {
    const a = SessionId('s1')
    const b = SessionId('s1')
    const c = SessionId('s2')
    expect(a === b).toBe(true)
    expect(a === c).toBe(false)
  })

  it('supports .toString() and template literal interpolation', () => {
    const sid = SessionId('session-42')
    expect(sid.toString()).toBe('session-42')
    expect(`${sid}`).toBe('session-42')
    expect(sid + '').toBe('session-42')
  })

  it('maintains .length property from the underlying string', () => {
    expect(SessionId('abc').length).toBe(3)
    expect(SessionId('').length).toBe(0)
    expect(SessionId('a-long-session-id-12345').length).toBe(23)
  })

  it('supports .charAt(), .indexOf(), .slice() and other string methods', () => {
    const sid = SessionId('session-test')
    expect(sid.charAt(0)).toBe('s')
    expect(sid.indexOf('-')).toBe(7)
    expect(sid.slice(0, 7)).toBe('session')
    expect(sid.startsWith('session')).toBe(true)
    expect(sid.endsWith('test')).toBe(true)
    expect(sid.includes('sion')).toBe(true)
  })
})

describe('Branded<B> JSON serialization', () => {
  it('serializes to a plain JSON string', () => {
    const sid = SessionId('session-json')
    expect(JSON.stringify(sid)).toBe('"session-json"')
  })

  it('deserializes from JSON back to a string', () => {
    const parsed: string = JSON.parse('"session-parsed"')
    // At runtime the brand is erased, so we re-brand after deserialization.
    const rebranded = SessionId(parsed)
    expect(rebranded).toBe('session-parsed')
  })

  it('round-trips through structuredClone', () => {
    const sid = SessionId('session-clone')
    const cloned = structuredClone(sid)
    expect(cloned).toBe('session-clone')
    // The clone is a plain string (brand erased) — the owning factory
    // re-applies the brand. This is the expected runtime behavior.
    const rebranded = SessionId(cloned)
    expect(rebranded).toBe('session-clone')
  })
})

describe('Branded<B> in collections', () => {
  it('works as Map keys (string identity)', () => {
    const map = new Map<SessionId, string>()
    const s1 = SessionId('s1')
    const s2 = SessionId('s2')
    map.set(s1, 'first')
    map.set(s2, 'second')
    expect(map.get(SessionId('s1'))).toBe('first')
    expect(map.get(SessionId('s2'))).toBe('second')
    expect(map.size).toBe(2)
  })

  it('works as Set values (string identity)', () => {
    const set = new Set<SessionId>()
    set.add(SessionId('s1'))
    set.add(SessionId('s1')) // duplicate — same string value
    set.add(SessionId('s2'))
    expect(set.size).toBe(2)
    expect(set.has(SessionId('s1'))).toBe(true)
    expect(set.has(SessionId('s2'))).toBe(true)
  })

  it('works as object keys (plain string coercion)', () => {
    const sid = SessionId('session-key')
    const obj: Record<string, number> = { [sid]: 42 }
    expect(obj['session-key']).toBe(42)
    expect(obj[sid]).toBe(42)
  })
})

describe('Branded<B> with different brands at runtime', () => {
  it('does not prevent accidental cross-brand comparison at runtime', () => {
    // This is a feature of the type system: at runtime, all branded types are
    // strings, so equality comparison works across brands. The type system
    // prevents this at compile time, but runtime code (e.g. JSON deserialization,
    // Map lookups by string) may still compare cross-brand values.
    // Cast to string for the runtime comparison — the type system correctly
    // rejects `sid === callId` as unintentional.
    const sid = SessionId('same-value')
    const callId = CallId('same-value')
    // Runtime: both are the string 'same-value'
    expect(sid as string === callId as string).toBe(true)
    // This is EXPECTED behavior — the brand is a compile-time fiction.
    // The owning package's factory is the single source of truth for which
    // concrete strings are valid branded ids.
  })
})
