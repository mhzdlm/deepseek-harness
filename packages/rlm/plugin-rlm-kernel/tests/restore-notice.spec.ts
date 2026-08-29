/**
 * P2-A: the kernel registry must surface a model-visible `<ipython_state_restored>`
 * notice immediately after restore, via `appendRestoreNotice`, so the model sees
 * the namespace revival before it issues the next cell (prime injects the same
 * message right after restore rather than only prefixing the next tool result).
 */
import { describe, expect, it } from 'vitest'
import { SessionKernelRegistry } from '../src/kernels.ts'

interface Appended {
  type: string
  source: unknown
  text: string
  surfaceOp: string
}

function recordingSession() {
  const appended: Appended[] = []
  const session = {
    id: 'sess-restore',
    append(type: string, message: { content: Array<{ text: string }>; source: unknown }, options: { surfaceOp: string }) {
      appended.push({ type, source: message.source, text: message.content[0]?.text ?? '', surfaceOp: options.surfaceOp })
      return { seq: appended.length } as never
    },
  }
  return { session, appended }
}

function registryWith(resolveSession: ((id: string) => unknown) | undefined) {
  return new SessionKernelRegistry({
    dataDir: '/tmp/rlm-test',
    hostHandlers: {} as never,
    resolveSession: resolveSession as never,
  })
}

describe('restore notice (P2-A)', () => {
  it('injects a model-visible notice with revived and lost names', () => {
    const { session, appended } = recordingSession()
    const registry = registryWith(() => session)
    registry.appendRestoreNotice('sess-restore', {
      restored: ['df', 'x'],
      failed: [{ name: 'rlm' }],
    })
    expect(appended).toHaveLength(1)
    expect(appended[0]!.type).toBe('user/message')
    expect(appended[0]!.surfaceOp).toBe('append')
    expect((appended[0]!.source as { kind: string; form?: string }).kind).toBe('plugin')
    expect((appended[0]!.source as { form?: string }).form).toBe('notice')
    expect(appended[0]!.text).toContain('<ipython_state_restored> revived: df, x </ipython_state_restored>')
    expect(appended[0]!.text).toContain('<ipython_state_restored> lost (not restored): rlm </ipython_state_restored>')
  })

  it('does not append when there is no session resolver', () => {
    const { session, appended } = recordingSession()
    const registry = registryWith(undefined)
    // No resolver: appendRestoreNotice must be a silent no-op.
    registry.appendRestoreNotice('sess-restore', { restored: ['df'], failed: [] })
    expect(appended).toHaveLength(0)
    void session
  })

  it('does not append when the restore result is empty', () => {
    const { session, appended } = recordingSession()
    const registry = registryWith(() => session)
    registry.appendRestoreNotice('sess-restore', { restored: [], failed: [] })
    expect(appended).toHaveLength(0)
  })
})

describe('post-compaction notice (P3-#1)', () => {
  it('injects <ipython_state> listing surviving variables when a live kernel exists', async () => {
    const { session, appended } = recordingSession()
    const registry = registryWith(() => session)
    // White-box: register a fake live kernel whose namespace lists two names.
    const liveKernels = (registry as unknown as { kernels: Map<string, unknown> }).kernels
    liveKernels.set('sess-compact', { listNamespaceNames: async () => ['df', 'helper'] })
    await registry.notifyCompactionEnd('sess-compact')
    expect(appended).toHaveLength(1)
    expect(appended[0]!.type).toBe('user/message')
    expect(appended[0]!.surfaceOp).toBe('append')
    expect((appended[0]!.source as { kind: string; form?: string }).kind).toBe('plugin')
    expect((appended[0]!.source as { form?: string }).form).toBe('notice')
    expect(appended[0]!.text).toBe(
      '<ipython_state> still alive after compaction (kernel keeps running): df, helper </ipython_state>',
    )
  })

  it('does not append when no live kernel exists for the session', async () => {
    const { session, appended } = recordingSession()
    const registry = registryWith(() => session)
    await registry.notifyCompactionEnd('sess-compact')
    expect(appended).toHaveLength(0)
  })
})
