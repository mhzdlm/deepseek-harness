/**
 * Phase C exit demonstration (BUILD.md): the cross-session loop —
 * publish (session A) → pickup (session B, provisional nominations) →
 * re-verification → evidenced; human file edits captured as human-revision
 * events; criterion proposals parked for human approval.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RlmStore, withBaseCriteria } from '@deepseek-ai/dsh-plugin-rlm-store'
import type { RlmScope } from '@deepseek-ai/dsh-plugin-rlm-store'
import { publishToMailbox, pickupMailboxSeeds, syncMailboxProjection, detectHumanRevisions, importLegacyNotes, proposeCriterion, approveCriterion } from '../src/mailbox.ts'
import { consolidate } from '../src/consolidate.ts'
import { publishedDir, writeDraft, writeDialog, listDrafts, listPublished } from '../src/storage.ts'
import type { Note } from '../src/storage.ts'

let root: string
let memoryDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mailbox-'))
  memoryDir = join(root, 'memory')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const sessionA: RlmScope = { kind: 'session', id: 'session-a' }
const sessionB: RlmScope = { kind: 'session', id: 'session-b' }

describe('Phase C · cross-session loop', () => {
  it('publish → pickup (provisional nomination) → re-verify → evidenced', async () => {
    const store = withBaseCriteria(new RlmStore(join(root, 'store')))

    // Session A publishes its verified conclusion (gate enforce).
    const report = await publishToMailbox(store, {
      gateMode: 'enforce', sessionId: 'session-a', sessionScope: sessionA,
    }, [{
      subject: 'deploy-window',
      title: '[mailbox] Deploy window',
      content: 'The deploy window is Sunday 02:00 UTC.',
      kind: 'declarative',
      evidence: 'operator statement in session-a',
    }])
    expect(report.published).toBe(1)
    // Two-sided publish: the mailbox stream has the handoff, and so does the session stream.
    expect(store.view({ kind: 'mailbox' }).countsByType['rlm/handoff']).toBe(1)
    expect(store.view(sessionA).countsByType['rlm/handoff']).toBe(1)

    // Session B starts: pickup lands PROVISIONAL nominations (mailbox grade is never imported).
    await pickupMailboxSeeds(store, sessionB)
    const picked = store.beliefs(sessionB)
    expect(picked).toHaveLength(1)
    expect(picked[0]).toMatchObject({
      grade: 'provisional',
      subject: 'deploy-window',
      lastVerified: { channel: 'mailbox-pickup' },
    })
    expect(picked[0]?.lastVerified?.note).toContain('mailbox:')

    // Session B re-verifies (its own judgment) and promotes, superseding the
    // nomination — promotion is a creating verdict, so the new evidenced node
    // carries a supersedes edge and the nomination leaves the active set.
    await store.judge(sessionB, {
      criterionRef: 'crit/verify-eq31-tournament',
      verdict: 'promotion',
      belief: {
        kind: 'declarative',
        content: 'The deploy window is Sunday 02:00 UTC (re-verified locally).',
        subject: 'deploy-window',
        supersedes: { id: picked[0]!.id, reason: 're-verified locally' },
      },
      dataSupport: { summary: 'checked against the deploy config directly' },
      provenance: { eventRange: [1, store.view(sessionB).seq] },
    })
    const final = store.beliefs(sessionB)
    expect(final).toHaveLength(1)
    expect(final[0]?.grade).toBe('evidenced')
    expect(final[0]?.supersedes?.id).toBe(picked[0]?.id)
    // The mailbox copy stays provisional — the nomination was consumed, not the grade.
    expect(store.beliefs({ kind: 'mailbox' })[0]?.grade).toBe('provisional')
  })

  it('competing mailbox beliefs for one subject are ALL picked up and marked as a conflict set', async () => {
    const store = withBaseCriteria(new RlmStore(join(root, 'store')))
    const gate = { gateMode: 'enforce' as const, sessionId: 'session-a', sessionScope: sessionA }
    await publishToMailbox(store, gate, [{
      subject: 'release-cadence', title: 'A says weekly', content: 'Releases are weekly.', kind: 'declarative', evidence: 'a',
    }])
    await publishToMailbox(store, { ...gate, sessionId: 'session-c', sessionScope: { kind: 'session', id: 'session-c' } }, [{
      subject: 'release-cadence', title: 'C says daily', content: 'Releases are daily.', kind: 'declarative', evidence: 'c',
    }])
    // No silent winner: both stay active in the mailbox.
    expect(store.beliefs({ kind: 'mailbox' })).toHaveLength(2)

    const picked = await pickupMailboxSeeds(store, sessionB)
    expect(picked.picked).toBe(2)
    expect(picked.conflicts).toContain('release-cadence')
    const notes = store.beliefs(sessionB).map(b => b.lastVerified?.note ?? '')
    expect(notes.filter(n => n.includes('conflict-set'))).toHaveLength(2)
  })

  it('gateMode observe records intent without publishing', async () => {
    const store = withBaseCriteria(new RlmStore(join(root, 'store')))
    const report = await publishToMailbox(store, {
      gateMode: 'observe', sessionId: 'session-a', sessionScope: sessionA,
    }, [{ subject: 's', title: 't', content: 'c', kind: 'declarative', evidence: 'e' }])
    expect(report.observed).toBe(1)
    expect(store.view({ kind: 'mailbox' }).eventCount).toBe(0)
  })
})

describe('Phase C · the mailbox projection and its human channel', () => {
  it('publish renders files; a human edit is captured as a human-revision event; retraction removes the file', async () => {
    const store = withBaseCriteria(new RlmStore(join(root, 'store')))
    await publishToMailbox(store, {
      gateMode: 'enforce', sessionId: 'session-a', sessionScope: sessionA,
    }, [{ subject: 'deploy-window', title: 'Deploy window', content: 'Sunday 02:00 UTC.', kind: 'declarative', evidence: 'e' }])
    await syncMailboxProjection(store, memoryDir)

    const file = join(publishedDir(memoryDir), 'deploy-window.md')
    expect(existsSync(file)).toBe(true)
    const rendered = readFileSync(file, 'utf8')
    expect(rendered).toContain('Sunday 02:00 UTC.')
    expect(rendered).toContain('subject: "deploy-window"')

    // The human edits the file directly — the semantic-exempt write.
    writeFileSync(file, readFileSync(file, 'utf8').replace('02:00', '03:00'), 'utf8')
    const revisions = await detectHumanRevisions(store, memoryDir)
    expect(revisions).toBe(1)
    // The stream holds the human revision (physical path = the stream).
    expect(store.view({ kind: 'mailbox' }).countsByType['rlm/human-revision']).toBe(1)
    const active = store.beliefs({ kind: 'mailbox' })
    expect(active).toHaveLength(1)
    expect(active[0]?.content).toContain('03:00')
    expect(active[0]?.criterionRef).toBe('human-revision')

    // The projection re-renders stably from the view (idempotent).
    await syncMailboxProjection(store, memoryDir)
    expect(readFileSync(file, 'utf8')).toContain('03:00')

    // A human delete retracts the belief and removes the file on the next sync.
    rmSync(file)
    expect(await detectHumanRevisions(store, memoryDir)).toBe(1)
    await syncMailboxProjection(store, memoryDir)
    expect(existsSync(file)).toBe(false)
    expect(store.beliefs({ kind: 'mailbox' })).toHaveLength(0)
  })

  it('legacy published notes import as human-revision events, idempotently', async () => {
    // A pre-Phase-C note: frontmatter without a subject field.
    const dir = publishedDir(memoryDir)
    mkdirSync(dir, { recursive: true })
    const legacy = [
      '---',
      'kind: personal',
      'scope: global',
      'session_id: old-session',
      'title: "Legacy fact"',
      'source: turn:3',
      'source_conversation: old.jsonl',
      'created_at: 2026-08-01T00:00:00.000Z',
      'updated_at: 2026-08-01T00:00:00.000Z',
      'version: 3',
      'use_count: 4',
      'last_accessed: 2026-08-20T00:00:00.000Z',
      'gate: { mode: enforce, verdict: pass, reviewed_at: 2026-08-01T00:00:00.000Z }',
      '---',
      '',
      'The legacy fact body.',
    ].join('\n')
    writeFileSync(join(dir, 'legacy-fact.md'), legacy, 'utf8')

    const store = withBaseCriteria(new RlmStore(join(root, 'store')))
    expect(await importLegacyNotes(store, memoryDir)).toBe(1)
    // Idempotent: a second import is a no-op.
    expect(await importLegacyNotes(store, memoryDir)).toBe(0)
    // The legacy file was absorbed into the canonical projection name, its
    // usage counters carried over, and the next sync re-rendered it as a
    // projection-owned note (subject field present, grade visible).
    expect(existsSync(join(dir, 'legacy-fact.md'))).toBe(false)
    const canonical = join(dir, 'legacy-legacy-fact.md')
    expect(existsSync(canonical)).toBe(true)
    await syncMailboxProjection(store, memoryDir)
    const rendered = readFileSync(canonical, 'utf8')
    expect(rendered).toContain('The legacy fact body.')
    expect(rendered).toContain('use_count: 4')
    expect(rendered).toContain('subject: "legacy:legacy-fact"')
    expect(rendered).toContain('grade: provisional')
  })
})

describe('Phase C · criterion-revision track', () => {
  it('a proposal parks in the mailbox; human approval registers it for the runtime', async () => {
    const store = withBaseCriteria(new RlmStore(join(root, 'store')))
    const proposalId = 'crit/team-review'
    const id = await proposeCriterion(store, sessionA, {
      id: proposalId, tier: 'structured', title: 'Team-review criterion', reason: 'two-model agreement should count as structured evidence',
    })
    expect(id).toHaveLength(16)
    // Unapproved: the criterion is not registered yet.
    await expect(store.judge(sessionA, {
      criterionRef: proposalId, verdict: 'conclusion',
      belief: { kind: 'declarative', content: 'x' },
      dataSupport: { summary: 'x' }, provenance: { eventRange: [1, store.view(sessionA).seq] },
    })).rejects.toThrow(/unregistered criterion/)

    await approveCriterion(store, { id: proposalId, tier: 'structured', title: 'Team-review criterion', reason: 'approved by human' })
    // The approval event is on the mailbox stream.
    expect(store.view({ kind: 'mailbox' }).countsByType['rlm/human-revision']).toBe(1)
    // And the criterion now admits judgments (the session stream needs a
    // locatable provenance range first).
    await store.append(sessionA, 'rlm/observation', { kind: 'note', content: 'session context before the approved-criterion judgment' })
    const ok = await store.judge(sessionA, {
      criterionRef: proposalId, verdict: 'conclusion',
      belief: { kind: 'declarative', content: 'admitted under the approved criterion' },
      dataSupport: { summary: 'x' }, provenance: { eventRange: [1, store.view(sessionA).seq] },
    })
    expect(ok.type).toBe('rlm/judgment')
  })

  it('listCriteria exposes the registered set for audit surfaces', () => {
    const store = withBaseCriteria(new RlmStore(join(root, 'store')))
    const ids = store.listCriteria().map(c => c.id)
    expect(ids).toContain('crit/refine-whitelist')
    expect(ids).toContain('crit/verify-eq31-tournament')
    for (const c of store.listCriteria()) {
      expect(['deterministic', 'structured', 'open']).toContain(c.tier)
      expect(c.title.length).toBeGreaterThan(0)
    }
  })
})

describe('Phase C · consolidation lands in the mailbox', () => {
  const now = '2026-09-01T00:00:00.000Z'

  const writeDeployDraft = (body: string): string => {
    writeDialog(memoryDir, 's1', [
      JSON.stringify({ role: 'user', content: 'when can we deploy?' }),
      JSON.stringify({ role: 'assistant', content: 'The deploy window is Sunday 02:00 UTC.' }),
    ].join('\n'))
    const note: Note = {
      frontmatter: {
        kind: 'personal', scope: 'session', session_id: 's1', title: 'Deploy window',
        source: 'turn:1', source_conversation: 'dialog/s1.jsonl',
        created_at: now, updated_at: now, version: 1, use_count: 0, last_accessed: now,
        gate: { mode: 'observe', verdict: 'pass', reviewed_at: now },
      },
      body,
    }
    return writeDraft(memoryDir, note, 's1', 'Deploy window')
  }

  const consolidateOpts = (store: ReturnType<typeof withBaseCriteria>) => ({
    gateMode: 'enforce' as const,
    maxPublishedNotes: 200,
    maxPublishedBytes: 5_000_000,
    store,
    sessionScope: { kind: 'session' as const, id: 'consolidator' },
    sessionId: 'consolidator',
  })

  it('a draft promotes to a mailbox belief + projection, not a direct file write', async () => {
    const store = withBaseCriteria(new RlmStore(join(root, 'store')))
    writeDeployDraft('The deploy window is Sunday 02:00 UTC.')

    const result = await consolidate(memoryDir, consolidateOpts(store))
    expect(result.promoted).toBe(1)
    // The draft was consumed.
    expect(listDrafts(memoryDir)).toHaveLength(0)
    // The mailbox holds the promotion as a PROVISIONAL nomination under a
    // stable subject; the consolidating session recorded its handover decision.
    expect(store.view({ kind: 'mailbox' }).countsByType['rlm/handoff']).toBe(1)
    expect(store.view({ kind: 'session', id: 'consolidator' }).countsByType['rlm/handoff']).toBe(1)
    const active = store.beliefs({ kind: 'mailbox' })
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ subject: 'note:deploy-window', grade: 'provisional', kind: 'declarative' })
    // published/ holds exactly the projection file — no kind-subdir direct write.
    const published = listPublished(memoryDir)
    expect(published).toHaveLength(1)
    expect(readFileSync(published[0]!, 'utf8')).toContain('The deploy window is Sunday 02:00 UTC.')
    expect(readFileSync(published[0]!, 'utf8')).toContain('subject: "note:deploy-window"')
  })

  it('a near-duplicate draft revises the existing subject instead of piling up a conflict set', async () => {
    const store = withBaseCriteria(new RlmStore(join(root, 'store')))
    writeDeployDraft('The deploy window is Sunday 02:00 UTC.')
    await consolidate(memoryDir, consolidateOpts(store))
    // A second draft, high token overlap with the first, different fact.
    writeDeployDraft('The deploy window is Sunday 03:00 UTC.')
    const result = await consolidate(memoryDir, consolidateOpts(store))
    expect(result.promoted).toBe(1)

    // The revision superseded the previous belief — one active node, new content.
    const active = store.beliefs({ kind: 'mailbox' })
    expect(active).toHaveLength(1)
    expect(active[0]?.content).toContain('03:00')
    const all = store.view({ kind: 'mailbox' }).beliefs
    expect(all).toHaveLength(2)
    expect(all[1]?.supersedes?.id).toBe(all[0]?.id)
    // The projection file stays one-per-subject.
    expect(listPublished(memoryDir)).toHaveLength(1)
  })
})

describe('Phase D · publish freeze lock', () => {
  it('a frozen subject skips publication until a human release or revision', async () => {
    const store = withBaseCriteria(new RlmStore(join(root, 'store')))
    const mailbox: RlmScope = { kind: 'mailbox' }
    const gate = { gateMode: 'enforce' as const, sessionId: 'session-a', sessionScope: sessionA }
    const input = {
      subject: 'deploy-window',
      title: '[mailbox] Deploy window',
      content: 'The deploy window is Sunday 02:00 UTC.',
      kind: 'declarative' as const,
      evidence: 'operator statement in session-a',
    }
    const first = await publishToMailbox(store, gate, [input])
    expect(first.published).toBe(1)
    const belief = store.beliefs(mailbox).at(-1)
    if (!belief) throw new Error('publish failed')

    // The arbiter freezes the belief — the trust gate now locks publishing.
    await store.judge(mailbox, {
      criterionRef: 'crit/audit-freeze',
      verdict: 'freeze',
      target: belief.id,
      dataSupport: { summary: 'arbiter rejected a malformed objection' },
      provenance: { eventRange: [1, store.view(mailbox).seq] },
    })
    const second = await publishToMailbox(store, gate, [input])
    expect(second.published).toBe(0)
    expect(second.frozenSkips).toEqual(['deploy-window'])
    expect(store.view(mailbox).beliefs).toHaveLength(1)

    // Human batch review releases the freeze — publication flows again.
    await store.judge(mailbox, {
      criterionRef: 'crit/audit-release',
      verdict: 'unfreeze',
      target: belief.id,
      dataSupport: { summary: 'human reviewed and cleared' },
      provenance: { eventRange: [1, store.view(mailbox).seq] },
    })
    const third = await publishToMailbox(store, gate, [{ ...input, revision: true }])
    expect(third.published).toBe(1)
    expect(store.beliefs(mailbox).filter(b => b.status === 'active')).toHaveLength(1)
  })
})
