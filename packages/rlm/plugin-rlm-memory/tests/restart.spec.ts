/**
 * Restart regression: every mailbox entry point must behave identically on a
 * FRESH store instance (stream on disk, no in-memory view — the post-restart
 * shape) as on the writer instance. `view()`/`beliefs()` are synchronous and
 * never load from disk; these tests exist because the single-instance
 * "write-then-read" pattern masked the entire defect class (B1–B4).
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RlmStore, withBaseCriteria } from '@deepseek-ai/dsh-plugin-rlm-store'
import type { RlmScope } from '@deepseek-ai/dsh-plugin-rlm-store'
import { publishToMailbox, pickupMailboxSeeds, importLegacyNotes, syncMailboxProjection } from '../src/mailbox.ts'
import { listPublished } from '../src/storage.ts'

let root: string
const sessionA: RlmScope = { kind: 'session', id: 'session-a' }
const sessionB: RlmScope = { kind: 'session', id: 'session-b' }
const mailbox: RlmScope = { kind: 'mailbox' }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'restart-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const freshStore = () => withBaseCriteria(new RlmStore(join(root, 'store')))

async function publishOne(store: RlmStore, subject = 'deploy-window'): Promise<string> {
  await publishToMailbox(store, { gateMode: 'enforce', sessionId: 'session-a', sessionScope: sessionA }, [{
    subject,
    title: `[mailbox] ${subject}`,
    content: 'The deploy window is Sunday 02:00 UTC.',
    kind: 'declarative',
    evidence: 'operator statement in session-a',
  }])
  const belief = store.beliefs(mailbox).at(-1)
  if (!belief) throw new Error('publish failed')
  return belief.id
}

describe('restart regression · cold store instance over an on-disk stream', () => {
  it('the freeze lock holds after a restart (B1)', async () => {
    const storeA = freshStore()
    const id = await publishOne(storeA)
    await storeA.judge(mailbox, {
      criterionRef: 'crit/audit-freeze',
      verdict: 'freeze',
      target: id,
      dataSupport: { summary: 'arbiter rejected a malformed objection' },
      provenance: { eventRange: [1, storeA.view(mailbox).seq] },
    })

    const storeB = freshStore()
    const report = await publishToMailbox(storeB, { gateMode: 'enforce', sessionId: 'session-b', sessionScope: sessionB }, [{
      subject: 'deploy-window',
      title: '[mailbox] deploy-window',
      content: 'The deploy window moved to Monday.',
      kind: 'declarative',
      evidence: 'operator statement in session-b',
    }])
    expect(report.published).toBe(0)
    expect(report.frozenSkips).toEqual(['deploy-window'])
    expect(storeB.view(mailbox).beliefs).toHaveLength(1)
  })

  it('pickup sees mailbox seeds after a restart (B2)', async () => {
    const storeA = freshStore()
    await publishOne(storeA)

    const storeB = freshStore()
    const report = await pickupMailboxSeeds(storeB, sessionB)
    expect(report.picked).toBe(1)
    expect(storeB.beliefs(sessionB)[0]).toMatchObject({ grade: 'provisional', subject: 'deploy-window' })
  })

  it('legacy import stays idempotent across a restart (B3)', async () => {
    const memoryDir = join(root, 'memory')
    mkdirSync(join(memoryDir, 'published'), { recursive: true })
    writeFileSync(join(memoryDir, 'published', 'old-note.md'), '---\ntitle: Old\n---\nlegacy content\n', 'utf8')
    const storeA = freshStore()
    await importLegacyNotes(storeA, memoryDir)
    const seqAfterImport = storeA.view(mailbox).seq

    const storeB = freshStore()
    await importLegacyNotes(storeB, memoryDir)
    expect(storeB.view(mailbox).seq).toBe(seqAfterImport)
  })

  it('the projection renders mailbox content after a restart', async () => {
    const memoryDir = join(root, 'memory')
    const storeA = freshStore()
    await publishOne(storeA)

    const storeB = freshStore()
    const rendered = await syncMailboxProjection(storeB, memoryDir)
    expect(rendered).toBe(1)
    const published = listPublished(memoryDir)
    expect(published).toHaveLength(1)
    expect(readFileSync(published[0]!, 'utf8')).toContain('The deploy window is Sunday 02:00 UTC.')
  })
})
