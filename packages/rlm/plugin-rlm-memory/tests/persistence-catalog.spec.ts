/**
 * The persistence read path refuses a session log containing an event type
 * outside the generated KNOWN_SESSION_EVENT_TYPES unless the event carries the
 * ignorable envelope, which Session.append cannot produce. These events are
 * therefore loadable only while the generated catalog includes them; this
 * guard fails when a new type is emitted here without regenerating the
 * catalog (`pnpm run gen-persistence-catalog`).
 *
 * The catalog module is imported by relative path because the rlm packages
 * sit outside every consumer's dependency closure (see docs/cookbook/rlm-plugin-install.md), so a
 * package-name import does not resolve under vitest.
 */
import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES } from '../../../core/session/src/known-event-types.ts'
import { MEMORY_EVENT_TYPES } from '../src/events.ts'
import { SUBDIRS } from '../src/storage.ts'

describe('memory session events vs the persistence catalog', () => {
  it('every emitted event type is known to the persistence read path', () => {
    for (const type of MEMORY_EVENT_TYPES) {
      expect(
        KNOWN_SESSION_EVENT_TYPES.has(type),
        `${type} is missing from KNOWN_SESSION_EVENT_TYPES — run "pnpm run gen-persistence-catalog"`,
      ).toBe(true)
    }
  })

  it('persistent memory subdirectories include published/ and snapshots/ and archived/ (Phase B/C/D durable dirs)', () => {
    // Phase B writes `published/`; Phase C writes `snapshots/` (reverse-snapshot store,
    // REME.md §5.3 D11); Phase D writes `archived/` (retire target, REME.md §5.4 D12 — moved
    // notes must be declared in the dir layout so `ensureMemoryDirs` creates them).
    expect(SUBDIRS).toContain('published')
    expect(SUBDIRS).toContain('snapshots')
    expect(SUBDIRS).toContain('archived')
  })
})
