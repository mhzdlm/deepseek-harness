// @vitest-environment jsdom
// Verify/moa tool rows: degradation warning surfacing, lifecycle states,
// disclosure, and the trajectory Inspect handoff.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { RlmToolRow } from '../src/client/RlmToolRow.tsx'
import { zh } from '../src/client/locales.ts'

type RlmToolRowProps = Parameters<typeof RlmToolRow>[0]

const t: RlmToolRowProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

function settled(over: Partial<ToolResultNode> = {}, toolName = 'verify'): ToolResultNode {
  return {
    kind: 'tool-result',
    seq: 3,
    time: 3_000,
    callId: 'call-rlm',
    call: { name: toolName, argsRaw: '{"problem":"p"}' },
    callTime: 2_000,
    content: [{ type: 'text', text: 'fused best = candidate[0]' }],
    isError: false,
    callView: null,
    resultView: null,
    subCalls: [],
    ...over,
  }
}

function running(toolName = 'verify'): RunningToolCall {
  return { callId: 'call-rlm', name: toolName, argsRaw: '{"problem":"p"}', turn: 1, step: 1, time: 2_000, callView: null, subCalls: [] }
}

function props(block: RlmToolRowProps['block'], toolName: string, inspect?: () => void): RlmToolRowProps {
  return {
    callId: block.callId,
    toolName,
    block,
    openFile: vi.fn(),
    inspect,
    t,
  } as unknown as RlmToolRowProps
}

describe('RlmToolRow', () => {
  it('surfaces verify judge degradation as a warning and discloses the output', () => {
    const view = render(<RlmToolRow {...props(settled({
      content: [{ type: 'text', text: 'fused best = candidate[0]\nranking: 0 > 1\n\nverify: 1 judge(s) degraded or failed (judge-b)' }],
    }), 'verify')} />)
    const card = view.container.querySelector('[data-tool="verify"]')!
    expect(card.getAttribute('data-degraded')).toBe('true')
    expect(card.textContent).toContain('已降级 (1)')
    expect(screen.queryByLabelText('已降级')).toBeNull()

    fireEvent.click(screen.getByRole('button'))
    const warning = screen.getByLabelText('已降级')
    expect(warning.textContent).toContain('judge-b')
    expect(view.container.textContent).toContain('fused best = candidate[0]')
  })

  it('surfaces moa reference degradation and names the failed labels', () => {
    const view = render(<RlmToolRow {...props(settled({
      content: [{ type: 'text', text: 'moa [default] 1/2 references\nmoa: 1 reference(s) failed (model-a@p-a)\n\nsynthesis body' }],
    }), 'moa')} />)
    const card = view.container.querySelector('[data-tool="moa"]')!
    expect(card.getAttribute('data-degraded')).toBe('true')
    expect(card.textContent).toContain('已降级 (1)')

    fireEvent.click(screen.getByRole('button'))
    const warning = screen.getByLabelText('已降级')
    expect(warning.textContent).toContain('model-a@p-a')
  })

  it('renders a healthy call without degradation marking', () => {
    const view = render(<RlmToolRow {...props(settled(), 'verify')} />)
    const card = view.container.querySelector('[data-tool="verify"]')!
    expect(card.getAttribute('data-degraded')).toBeNull()
    expect(card.textContent).toContain('fused best = candidate[0]')
    expect(card.textContent).not.toContain('已降级')
  })

  it('keeps a running call compact and announces its state', () => {
    const view = render(<RlmToolRow {...props(running(), 'verify')} />)
    expect(view.container.textContent).toContain('运行中')
    expect(view.container.textContent).toContain('Verify')
    expect(view.container.querySelector('[data-state="ongoing"]')).not.toBeNull()
  })

  it('uses the first failure line in the summary and exposes the full error', () => {
    const view = render(<RlmToolRow {...props(settled({
      content: [{ type: 'text', text: 'boom: everything failed\nmore detail here' }],
      isError: true,
      error: { name: 'Error', code: 'boom' },
    }), 'verify')} />)
    const card = view.container.querySelector('[data-tool="verify"]')!
    expect(card.getAttribute('data-state')).toBe('error')
    expect(card.textContent).toContain('boom: everything failed')
    expect(card.textContent).not.toContain('more detail here')

    fireEvent.click(screen.getByRole('button'))
    const output = view.container.querySelector('pre')!
    expect(output.textContent).toBe('boom: everything failed\nmore detail here')
  })

  it('hands the trajectory Inspect through when available', () => {
    const inspect = vi.fn()
    render(<RlmToolRow {...props(settled(), 'verify', inspect)} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('button', { name: '检查' }))
    expect(inspect).toHaveBeenCalledTimes(1)
  })
})
