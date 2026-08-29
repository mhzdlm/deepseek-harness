/**
 * Unit tests for transcript sanitization (strip tool-result blocks, REME.md §5.1 D5).
 */
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { sanitizeTurns, renderDialogJsonl, renderDialogText, type CaptureTurn } from '../src/sanitize.ts'

const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

const turn = (role: string, content: string, extra: Partial<CaptureTurn> = {}): CaptureTurn => ({ role, content, ...extra })

describe('sanitizeTurns', () => {
  it('drops tool-role turns and keeps user/model/system turns in order', () => {
    const turns = [
      turn('user', 'how do I sort?'),
      turn('assistant', 'use sorted()'),
      turn('tool', '[{x:1}]', { toolName: 'python', toolId: 'call_1' }),
      turn('user', 'thanks'),
    ]
    const out = sanitizeTurns(turns)
    expect(out.map(t => t.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('returns an empty array when all turns are tool results', () => {
    expect(sanitizeTurns([turn('tool', 'x'), turn('tool', 'y')])).toEqual([])
  })

  it('strips tool identifiers from the kept turns (tool turns removed entirely)', () => {
    const out = sanitizeTurns([turn('tool', 'secret', { toolName: 'python', toolId: 'c1' })])
    expect(out).toHaveLength(0)
  })
})

describe('renderDialogJsonl', () => {
  it('emits one role/content JSON object per sanitized turn, newline-terminated', () => {
    const jsonl = renderDialogJsonl([turn('user', 'hi'), turn('assistant', 'hello')])
    const lines = jsonl.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toEqual({ role: 'user', content: 'hi' })
    expect(JSON.parse(lines[1]!)).toEqual({ role: 'assistant', content: 'hello' })
  })

  it('returns empty string when no turns survive sanitization', () => {
    expect(renderDialogJsonl(sanitizeTurns([turn('tool', 'x')]))).toBe('')
  })
})

describe('renderDialogText', () => {
  it('renders plain role: content lines, tool turns excluded', () => {
    const text = renderDialogText([turn('user', 'q'), turn('tool', 'r'), turn('assistant', 'a')])
    expect(text).toBe('user: q\nassistant: a')
  })
})
