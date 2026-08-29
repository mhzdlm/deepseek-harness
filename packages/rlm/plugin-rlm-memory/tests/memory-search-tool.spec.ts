/**
 * Unit tests for the Phase B `memory_search` tool: schema snapshot (query
 * required), and execute behaviour with a fake exec carrying a real session —
 * returns text containing the matched note's title and increments its use_count
 * (REME.md §5.2 D8, §8 D4). `defineTool` does NOT accept a `purpose` field, so
 * the test asserts the schema shape only (no purpose).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemorySearchTool } from '../src/memory-search-tool.ts'
import { ensureMemoryDirs, writePublished, parseNote, type Note, type NoteFrontmatter } from '../src/storage.ts'

const roots: string[] = []
const tmp = (): string => {
  const r = mkdtempSync(join(tmpdir(), 'memory-tool-'))
  roots.push(r)
  return r
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function sampleNote(source: string, body: string): Note {
  const now = new Date().toISOString()
  const frontmatter: NoteFrontmatter = {
    kind: 'procedure', scope: 'session', session_id: 's', source,
    source_conversation: 'dialog/s.jsonl', created_at: now, updated_at: now,
    version: 1, use_count: 0, last_accessed: now,
    gate: { mode: 'observe', verdict: 'pass', reviewed_at: now },
  }
  return { frontmatter, body }
}

// Minimal fake exec: the tool reads `exec.agent?.session` for the owning session.
function fakeExec(sessionId: string) {
  return { agent: { session: { id: sessionId } } }
}

describe('memory_search tool schema', () => {
  const tool = createMemorySearchTool({ memoryDir: tmp(), recallTopK: 5, recallMode: 'keyword' })

  it('declares query as a required parameter (schema snapshot)', () => {
    // `defineTool` compiles the field-map into a JSON Schema object: requiredness
    // lives in the root `required` array, and each property is a plain JSON Schema
    // node (no per-property `required` flag).
    const params = tool.parameters as { type: string; properties: Record<string, { type: string }>; required: string[] }
    expect(params.type).toBe('object')
    expect(params.required).toContain('query')
    expect(params.properties.query.type).toBe('string')
    expect(params.properties.limit.type).toBe('integer')
    expect(params.properties.kind.type).toBe('string')
  })

  it('has a name and an output render projection', () => {
    expect(tool.name).toBe('memory_search')
    expect(typeof (tool as { output: { render: unknown } }).output.render).toBe('function')
  })
})

describe('memory_search tool execute', () => {
  it('returns text containing the matched note title and increments use_count', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    const path = writePublished(dir, sampleNote('recall-target', '# Deploy Checklist\nSteps to deploy the service safely.'))
    const tool = createMemorySearchTool({ memoryDir: dir, recallTopK: 5, recallMode: 'keyword' })

    const before = parseNote(path)!
    expect(before.frontmatter.use_count).toBe(0)

    const result = await tool.execute({ query: 'deploy service', limit: 5 }, fakeExec('sess-1') as never) as { text: string; count: number }

    expect(result.count).toBeGreaterThanOrEqual(1)
    expect(result.text).toContain('Deploy Checklist')

    const after = parseNote(path)!
    expect(after.frontmatter.use_count).toBe(1)
    expect(after.frontmatter.version).toBe(before.frontmatter.version)
  })

  it('throws without an owning session (mirrors loop-tool sessionId guard)', async () => {
    const dir = tmp()
    const tool = createMemorySearchTool({ memoryDir: dir, recallTopK: 5, recallMode: 'keyword' })
    await expect(tool.execute({ query: 'x' }, {} as never)).rejects.toThrow(/requires an owning agent session/)
  })

  it('returns an empty result (no throw) for a query matching nothing', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    writePublished(dir, sampleNote('a', '# A\nalpha content.'))
    const tool = createMemorySearchTool({ memoryDir: dir, recallTopK: 5, recallMode: 'keyword' })
    const result = await tool.execute({ query: 'nonexistent-term-zzz' }, fakeExec('sess-2') as never) as { text: string; count: number }
    expect(result.count).toBe(0)
    expect(result.text).toContain('no published note matched')
  })
})
