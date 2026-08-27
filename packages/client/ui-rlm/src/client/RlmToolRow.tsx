// RlmToolRow: keyed toolview for the `verify` and `moa` tools. A compact row
// whose summary reflects judge/reference degradation and discloses the exact
// rendered output. Degradation is detected from the durable result text — the
// tool renderers name failed judges/references there (verify: "N judge(s)
// degraded or failed (...)", moa: "N reference(s) failed (...)") — so the row
// stays a pure function of the frozen call slice and replay is stable.

import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './RlmToolRow.module.css'

/** Full row props: the toolview runtime share plus this package's locale seat. */
type RlmToolRowProps = ToolCallViewProps & PropsLocale<'rlm'>

/** Row lifecycle derived solely from the durable call slice. */
type RlmRowState = 'running' | 'ok' | 'error' | 'stopped'

/** Compact, replay-stable view model for the row. */
interface RlmRowModel {
  readonly title: string
  readonly summary: string
  readonly output: string | null
  readonly degraded: boolean
  readonly failed: readonly string[]
  readonly state: RlmRowState
}

/** Degradation markers the verify/moa renderers embed in the result text. */
const DEGRADED_PATTERNS: Readonly<Record<string, RegExp>> = {
  verify: /\d+ judge\(s\) degraded or failed \(([^)]+)\)|\bscoring degraded\b/i,
  moa: /\d+ reference\(s\) failed \(([^)]+)\)|Reference failed:/i,
}

/** First physical line for the collapsed summary. */
function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/** Flatten durable result blocks under the generic Tool-row text contract. */
function flattenResult(block: ToolCallViewProps['block']): string | null {
  if (!('kind' in block)) return null
  const parts: string[] = []
  for (const item of block.content) {
    parts.push(item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
  }
  if (parts.length === 0 && block.error !== undefined) {
    parts.push(`${block.error.name}: ${block.error.code}`)
  }
  return parts.join('\n') || null
}

/** Detect degradation and the failed names from the rendered result text. */
function detectDegradation(toolName: string, text: string): { degraded: boolean; failed: readonly string[] } {
  const pattern = DEGRADED_PATTERNS[toolName]
  if (pattern === undefined) return { degraded: false, failed: [] }
  const match = text.match(pattern)
  if (match === null) return { degraded: false, failed: [] }
  const named = match[1]
  return named === undefined
    ? { degraded: true, failed: [] }
    : { degraded: true, failed: named.split(',').map(name => name.trim()).filter(name => name !== '') }
}

/** Derive display state without consulting any live service. */
function rlmRowModel(block: ToolCallViewProps['block'], toolName: string, t: RlmToolRowProps['t']): RlmRowModel {
  const settled = 'kind' in block
  const state: RlmRowState = !settled
    ? 'running'
    : block.error?.code === 'interrupted'
      ? 'stopped'
      : block.isError ? 'error' : 'ok'
  const output = flattenResult(block)
  const detection = output === null
    ? { degraded: false, failed: [] as readonly string[] }
    : detectDegradation(toolName, output)
  const title = toolName === 'moa' ? t('moa.title') : t('verify.title')
  const summary = !settled
    ? t('row.running')
    : state === 'error'
      ? firstLine(output ?? '')
      : detection.degraded
        ? detection.failed.length > 0
          ? `${t('row.degraded')} (${detection.failed.length})`
          : t('row.degraded')
        : firstLine(output ?? '')
  return { title, summary, output, degraded: detection.degraded, failed: detection.failed, state }
}

/** Warning-leading dot: warning on degradation, lifecycle dot otherwise. */
function leadingFor(state: RlmRowState, degraded: boolean): ReactNode {
  const dotState = degraded ? 'warning' as const
    : state === 'running' ? 'ongoing' as const
      : state === 'error' ? 'error' as const
        : 'done' as const
  return <StateDot state={dotState} size={10} />
}

/**
 * Render one `verify` or `moa` tool call as a summary row with a degradation
 * warning disclosure.
 * @param props - keyed toolview payload plus the rlm locale seat.
 * @returns the dedicated rlm row.
 */
export function RlmToolRow({ block, toolName, inspect, t }: RlmToolRowProps) {
  const model = rlmRowModel(block, toolName, t)
  const [expanded, setExpanded] = useState(false)
  const expandable = model.output !== null
  const open = expanded && expandable
  const toggleExpand = (): void => setExpanded(value => !value)
  const toggleFromKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    toggleExpand()
  }
  const disclosureProps = expandable ? {
    role: 'button' as const,
    tabIndex: 0,
    'aria-expanded': open,
    onClick: toggleExpand,
    onKeyDown: toggleFromKeyboard,
  } : {}
  return (
    <div className={css.card} data-tool={toolName} data-degraded={model.degraded || undefined} data-state={model.state}>
      <div
        className={css.row}
        data-expandable={expandable || undefined}
        {...disclosureProps}
      >
        <span className={css.leading}>{leadingFor(model.state, model.degraded)}</span>
        <span className={css.title}>{model.title}</span>
        <span className={model.degraded ? `${css.summary} ${css.degradedSummary}` : css.summary}>{model.summary}</span>
      </div>
      {open ? (
        <div className={css.bodyWrap}>
          {model.degraded ? (
            <section className={css.warningCard} aria-label={t('row.degraded')}>
              <div className={css.warningHeader}>{t('row.degraded')}</div>
              <div className={css.warningBody}>
                {model.failed.length > 0 ? model.failed.join(', ') : t('row.degraded')}
              </div>
            </section>
          ) : null}
          <section className={css.outputCard}>
            <div className={css.outputLabel}>{t('row.output')}</div>
            <pre className={css.output} data-error={model.state === 'error' || undefined}>{model.output}</pre>
          </section>
          {inspect !== undefined ? (
            <button type="button" className={css.inspectButton} onClick={inspect}>
              {t('row.inspect')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
