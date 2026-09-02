/**
 * Active recall injection (T7.13, LAYERS.md §3): unit coverage for the pure
 * query/render helpers and the apply()-level three-branch behavior (off /
 * observe / enforce) of the harness section suffix, including the hard budget
 * and the log-only `session/memory-recall-inject` event. The section render is
 * driven through the real `apply()` with a minimal context capturing the
 * `systemPrompt.section` callback. The memory store sits at `<dataDir>/memory`
 * (the plugin's derived default), matching the memory package layout.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { writePublished } from '@deepseek-ai/dsh-plugin-rlm-memory/src/storage.ts'
import type { Note } from '@deepseek-ai/dsh-plugin-rlm-memory/src/storage.ts'
import { latestUserQuery, renderRecallSection } from '../src/recall-inject.ts'
import { apply } from '../src/index.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-recall-'))
  roots.push(root)
  return root
}

function publishAt(memoryDir: string, id: string, title: string, body: string): void {
  const note: Note = {
    frontmatter: {
      kind: 'personal',
      scope: 'session',
      session_id: 's0',
      source: 'turn:0',
      source_conversation: 'dialog/s0.jsonl',
      created_at: '2026-08-22T00:00:00Z',
      updated_at: '2026-08-22T00:00:00Z',
      version: 1,
      use_count: 0,
      last_accessed: '2026-08-22T00:00:00Z',
      gate: { mode: 'observe' as const, verdict: 'pass' as const, reviewed_at: '2026-08-22T00:00:00Z' },
    },
    // The display title is the first `#`-headed line of the body (search's rule).
    body: `# ${title}\n${body}`,
  }
  mkdirSync(join(memoryDir, 'published'), { recursive: true })
  writePublished(memoryDir, note, `published/personal/${id}.md`)
}

interface FakeMsg {
  role: string
  content: Array<{ type: string; text: string }>
}

interface SectionHarness {
  /** The fake owning session: event appends land in `events`. */
  session: { id: string; deriveMessages: () => FakeMsg[]; append: (t: string, p: never) => void }
  render(session: unknown): string
  events: Array<{ type: string; payload: Record<string, unknown> }>
}

function makeSectionHarness(config: Record<string, unknown>, messages: FakeMsg[]): SectionHarness {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = []
  let render: (context: unknown) => string = () => ''
  const session = {
    id: 'recall-session',
    deriveMessages: () => messages,
    append: (type: string, payload: Record<string, unknown>) => events.push({ type, payload }),
  }
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    get: (_key: string) => undefined,
    systemPrompt: {
      section: (spec: { text: (context: unknown) => string }) => {
        render = spec.text
        return () => undefined
      },
    },
    commands: {
      register: () => () => undefined,
    },
  } as unknown as Context
  apply(ctx, config as never)
  return {
    session: { id: session.id, deriveMessages: session.deriveMessages, append: session.append },
    render: incoming => render({ scope: { session: incoming ?? session }, signal: new AbortController().signal }),
    events,
  }
}

describe('recall-inject helpers (T7.13)', () => {
  it('extracts the most recent user message as the query, truncated', () => {
    const session = {
      deriveMessages: () => [
        { role: 'assistant', content: [{ type: 'text', text: 'sure' }] },
        { role: 'user', content: [{ type: 'text', text: 'how do I deploy the harness' }] },
      ],
    }
    expect(latestUserQuery(session)).toBe('how do I deploy the harness')
    expect(latestUserQuery(session, 8)).toBe('how do I')
    // No user message => undefined (nothing to recall on).
    const assistantOnly = { deriveMessages: () => [{ role: 'assistant', content: [] }] }
    expect(latestUserQuery(assistantOnly)).toBeUndefined()
    // Blank user messages are skipped, falling back to the prior one.
    const blankUser = {
      deriveMessages: () => [
        { role: 'assistant', content: [] },
        { role: 'user', content: [{ type: 'text', text: '   ' }] },
        { role: 'user', content: [{ type: 'text', text: 'the real question' }] },
      ],
    }
    expect(latestUserQuery(blankUser)).toBe('the real question')
  })

  it('renders hits in rank order with a hard budget and truncation marker', () => {
    const hits = [
      { relPath: 'personal/a.md', title: 'Deploy guide', kind: 'personal', score: 9.5, body: 'short body' },
      { relPath: 'personal/b.md', title: 'Second hit', kind: 'wiki', score: 3.25, body: 'another body' },
    ]
    const rendered = renderRecallSection('deploy', hits, 10_000)
    expect(rendered).toContain('## Relevant Memories')
    expect(rendered).toContain('Deploy guide')
    expect(rendered).toContain('Second hit')
    expect(rendered).toContain('short body')

    // Budget stops the second hit outright.
    const tight = renderRecallSection('deploy', hits, 120)
    expect(tight).toContain('Deploy guide')
    expect(tight).not.toContain('Second hit')

    // Budget truncates the admitted body with the ellipsis marker: 90 fits the
    // first header and leaves only 4 chars of body room (< 12).
    const clipped = renderRecallSection('deploy', hits, 90)
    expect(clipped.endsWith('…')).toBe(true)

    expect(renderRecallSection('deploy', [], 10_000)).toBe('')
  })
})

describe('recall injection section (T7.13 apply-level)', () => {
  const messages: FakeMsg[] = [
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: 'how do I deploy the harness' }] },
  ]

  it('off: prompt unchanged and no event', () => {
    const root = newRoot()
    publishAt(join(root, 'memory'), 'a', 'Deploy guide', 'deploy the harness with pnpm')
    const h = makeSectionHarness({ dataDir: root, recallInject: 'off' }, messages)
    const text = h.render(h.session)
    expect(text).not.toContain('## Relevant Memories')
    expect(h.events).toHaveLength(0)
  })

  it('observe (default): recall runs, event records hits, prompt stays unchanged', () => {
    const root = newRoot()
    publishAt(join(root, 'memory'), 'a', 'Deploy guide', 'deploy the harness with pnpm')
    const h = makeSectionHarness({ dataDir: root }, messages)
    const text = h.render(h.session)
    expect(text).not.toContain('## Relevant Memories')
    expect(h.events).toHaveLength(1)
    expect(h.events[0]!.type).toBe('session/memory-recall-inject')
    expect(h.events[0]!.payload.mode).toBe('observe')
    expect((h.events[0]!.payload.hitIds as string[]).some(id => id.includes('a.md'))).toBe(true)
  })

  it('enforce: the recall section is appended to the overview', () => {
    const root = newRoot()
    publishAt(join(root, 'memory'), 'a', 'Deploy guide', 'deploy the harness with pnpm')
    const h = makeSectionHarness({ dataDir: root, recallInject: 'enforce' }, messages)
    const text = h.render(h.session)
    expect(text).toContain('## Relevant Memories')
    expect(text).toContain('Deploy guide')
    expect(h.events[0]!.payload.mode).toBe('enforce')
    expect((h.events[0]!.payload.injectedChars as number)).toBeGreaterThan(0)
  })

  it('no hits: no injection and the event records an empty result', () => {
    const root = newRoot()
    const h = makeSectionHarness({ dataDir: root, recallInject: 'enforce' }, messages)
    const text = h.render(h.session)
    expect(text).not.toContain('## Relevant Memories')
    expect(h.events[0]!.payload.hitIds).toEqual([])
  })
})
