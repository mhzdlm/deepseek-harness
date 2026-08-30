/**
 * 主动召回注入（T7.13, LAYERS.md §3 中间层第一项）：渲染
 * `continual-harness` section 时，用最近一条 user message 做一次轻量检索，
 * 把 top-N 相关 memory 全文注入 section（替代/补充纯时间索引），带预算硬上限。
 * 三分支纪律（off | observe | enforce）：默认 `observe` — 检索并记录事件，
 * prompt 不注入；`enforce` 才实际注入。守卫在代码不在提示词：注入段有硬预算，
 * 不会打爆上下文。
 *
 * @module @deepseek-ai/dsh-plugin-continual-harness/recall-inject
 */

// Phase 8: through the package's compiled entry — a non-relative `.ts`
// specifier cannot be rewritten during emit (TS2877) and cannot load from
// node_modules under plain Node.
import type { SearchHit } from '@deepseek-ai/dsh-plugin-rlm-memory'

/** Structural slice of a derived session message (as the session.query bridge reads). */
export interface DerivedMessageLike {
  role: string
  content: unknown
}

/** Structural slice of the owning agent's session, for the latest-user-query extraction. */
export interface SessionLike {
  deriveMessages(): DerivedMessageLike[]
}

/**
 * Flatten a derived message's content blocks to text.
 * @param content - the message content value (string or content-block array).
 * @returns the concatenated text.
 */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : ''))
    .filter(Boolean)
    .join(' ')
}

/**
 * Extract the most recent user message text from a derived session transcript,
 * truncated to a query budget so the recall query stays cheap and bounded.
 * @param session - the owning session (derived messages).
 * @param maxQueryChars - query character cap (default 200).
 * @returns the trimmed query text, or undefined when the transcript has no user message.
 */
export function latestUserQuery(session: SessionLike, maxQueryChars = 200): string | undefined {
  for (const message of [...session.deriveMessages()].reverse()) {
    if (message.role !== 'user') continue
    const text = messageText(message.content).trim()
    if (text.length === 0) continue
    return text.slice(0, maxQueryChars)
  }
  return undefined
}

/**
 * Render the recall injection section from ranked hits, honoring a hard
 * character budget: hits are appended in rank order, and the last admitted
 * body is truncated to the remaining budget. Returns '' for no hits.
 * @param query - the recall query (for the section header).
 * @param hits - ranked search hits (already limited to top-N by the caller).
 * @param budgetChars - hard budget for the whole injected section.
 * @returns the injected markdown section, or '' when there are no hits.
 */
export function renderRecallSection(query: string, hits: readonly SearchHit[], budgetChars: number): string {
  if (hits.length === 0) return ''
  const lines: string[] = [`## Relevant Memories (recall of "${query.slice(0, 80)}")`]
  let used = (lines[0] ?? '').length + 1
  for (const hit of hits) {
    const header = `- **${hit.title}** (${hit.kind}, score ${hit.score.toFixed(2)})`
    const remaining = budgetChars - used
    if (remaining <= 0 || header.length > remaining) break
    const bodyLine = `  ${hit.body.trim()}`
    const bodyRoom = Math.max(0, remaining - header.length - 3)
    const body = bodyLine.length > remaining - header.length - 2 ? bodyLine.slice(0, bodyRoom) + '…' : bodyLine
    lines.push(header)
    lines.push(body)
    used += header.length + body.length + 2
  }
  return lines.join('\n')
}

export type { SearchHit }
