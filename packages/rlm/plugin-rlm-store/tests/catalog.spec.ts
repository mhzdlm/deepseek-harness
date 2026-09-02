/**
 * Pinning test for the store's own event catalog (persistence-catalog
 * pattern, store-local): every emitted event type must have a catalog entry
 * and every catalog entry must be an emitted event type, so the write path
 * and the read path can never drift apart silently.
 */
import { describe, expect, it } from 'vitest'
import { RLM_EVENT_CATALOG, isKnownEventType } from '../src/catalog.ts'
import { RLM_EVENT_TYPES } from '../src/events.ts'

describe('rlm store event catalog', () => {
  it('every event type has exactly one catalog entry', () => {
    for (const type of RLM_EVENT_TYPES) {
      expect(RLM_EVENT_CATALOG[type], `${type} is missing from RLM_EVENT_CATALOG`).toBeDefined()
    }
  })

  it('every catalog entry is an event type (no dead catalog rows)', () => {
    for (const type of Object.keys(RLM_EVENT_CATALOG)) {
      expect(RLM_EVENT_TYPES as readonly string[]).toContain(type)
    }
  })

  it('the seven r9 event types are all present', () => {
    expect(RLM_EVENT_TYPES).toHaveLength(7)
    expect(RLM_EVENT_TYPES).toContain('rlm/judgment')
    expect(RLM_EVENT_TYPES).toContain('rlm/human-revision')
  })

  it('judgment is legal in both scopes; human revision is mailbox-only', () => {
    expect(RLM_EVENT_CATALOG['rlm/judgment'].scopes).toEqual(['session', 'mailbox'])
    expect(RLM_EVENT_CATALOG['rlm/human-revision'].scopes).toEqual(['mailbox'])
  })

  it('isKnownEventType refuses anything outside the catalog', () => {
    expect(isKnownEventType('rlm/judgment')).toBe(true)
    expect(isKnownEventType('rlm/future-thing')).toBe(false)
    expect(isKnownEventType('session/memory-captured')).toBe(false)
  })
})
