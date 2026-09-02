/**
 * Tool-outcome landing helper: the last mile of Phase A item 4 (BUILD.md) —
 * judgment tools (verify / moa) record their outcome through the judgment
 * channel instead of letting it evaporate into the transcript. One observation
 * event anchors the input, one judgment lands the outcome as a belief.
 *
 * Best-effort by design (same philosophy as the log-only process events): a
 * landing failure is warned and swallowed — the tool's primary result must
 * never fail because its store echo did.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-store/land
 */

import type { RlmEvent, RlmScope, RlmStore } from './store.ts'
import type { RlmEventPayload, RlmVerdictForm } from './events.ts'

/** Content cap for tool-landed beliefs: oversized tool output is truncated at the landing boundary. */
export const LANDING_CONTENT_CAP = 8000

export interface ToolLandingInput {
  /** Observation payload anchoring the input side (request shape, counts). */
  observation: RlmEventPayload
  /** Registered criterion reference, e.g. `crit/verify-eq31-tournament`. */
  criterionRef: string
  /** The outcome verdict — `selection` for verify, `merge` for moa. */
  verdict: RlmVerdictForm
  /** The outcome content (the selected answer / the synthesis). */
  content: string
  /** Stable subject key tying re-runs of the same question together. */
  subject: string
  /** Verification channel recorded on the belief. */
  channel: string
  /** One-line data-support summary (the scoring facts). */
  dataSupportSummary: string
  /** Optional title — set it only when the outcome belongs in the harness overview. */
  title?: string
}

function truncate(text: string): string {
  return text.length <= LANDING_CONTENT_CAP
    ? text
    : `${text.slice(0, LANDING_CONTENT_CAP)}\n[truncated at landing boundary — full text in the tool result]`
}

/**
 * Land a tool outcome as observation + judgment. Best-effort: returns the
 * judgment event, or null when no store is wired or the landing was refused
 * (both warned).
 * @param store - the unified store, or undefined when not assembled.
 * @param scope - the session scope to land into.
 * @param input - the landing description.
 * @returns the judgment event, or null.
 */
export async function landToolOutcome(
  store: RlmStore | undefined,
  scope: RlmScope,
  input: ToolLandingInput,
): Promise<RlmEvent | null> {
  if (!store) return null
  try {
    const observation = await store.append(scope, 'rlm/observation', input.observation)
    return await store.judge(scope, {
      criterionRef: input.criterionRef,
      verdict: input.verdict,
      belief: {
        kind: 'declarative',
        content: truncate(input.content),
        subject: input.subject,
        ...(input.title !== undefined ? { title: input.title } : {}),
        basedOn: [],
        lastVerified: { channel: input.channel, eventPos: observation.seq },
      },
      dataSupport: { summary: input.dataSupportSummary },
      provenance: { eventRange: [observation.seq, observation.seq] },
    })
  } catch (error) {
    console.warn(`[rlm-store] tool landing refused (${input.criterionRef}):`, error)
    return null
  }
}
