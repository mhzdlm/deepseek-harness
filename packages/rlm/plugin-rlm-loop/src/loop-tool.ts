/**
 * The `loop` tool: Loop Engineering bookkeeping for a model-driven
 * Manage→Execute→Audit run. The joining session IS the manager — episodes ride
 * the composition-provided executor/auditor delegation tools — so this tool
 * owns only what must not depend on model compliance:
 *
 * - deterministic parsing of the auditor's three-line report header,
 * - the trust gate (only clean+complete+aligned rounds become progress),
 * - durable `rlm/action-boundary` events in the session's store stream,
 * - the round audit as a **check judgment** through the store's judgment
 *   channel (`crit/loop-three-line-header`), landing verified progress as a
 *   belief node — the harness overview picks it up via the store projection.
 *
 * Phase A (BUILD.md): the old direct write into harness_state.json is gone;
 * the store is the single write path and the file is a projection of it.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-loop/loop-tool
 */

import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { RlmScope, RlmStore } from '@deepseek-ai/dsh-plugin-rlm-store'
import { isCleanComplete, parseAuditHeader } from './parse.ts'

/**
 * Construction options for the `loop` tool: the session's store (the single
 * write path), the soft round ceiling, and an optional shared live-run map the
 * plugin can evict.
 */
export interface LoopToolOptions {
  /** The unified store; judgments and action boundaries land here. */
  store: RlmStore
  /** Soft per-run round ceiling; exceeding it warns but never blocks. */
  maxRounds: number
  /**
   * Shared live-run map keyed by session id. The plugin assembly supplies one
   * so it can evict entries on session disposal; omitted, the tool keeps a
   * private map (fine for tests and short-lived hosts).
   */
  runs?: Map<string, LoopRun>
}

interface RecordedRound {
  round: number
  route: string
  accepted: boolean
  status: string
  integrity: string
  contractAudit: string
}

/** A single Manage→Execute→Audit run tracked by the `loop` tool for one session. */
export interface LoopRun {
  runId: string
  task: string
  contract: string
  /** Stream position of this run's begin action boundary (provenance anchor). */
  beginSeq: number
  rounds: RecordedRound[]
}

const ROUTES = new Set(['gui', 'cli', 'done', 'blocked', 'ask'])

/**
 * Tool-facing result of one `loop` call: a human-readable summary plus the
 * structured verdict fields the renderer echoes and callers may inspect.
 */
export interface LoopToolResult {
  text: string
  runId?: string
  round?: number
  accepted?: boolean
  status?: string
  integrity?: string
  contractAudit?: string
  landed?: boolean
}

function sessionIdOf(exec: { agent?: { session?: Session } }): { sid: string; session: Session | null } {
  const session = exec.agent?.session ?? null
  return session ? { sid: String(session.id), session } : { sid: '', session: null }
}

/**
 * Build the `loop` tool around the unified store.
 *
 * @param options - Construction options: the store, a soft round ceiling, and
 *   an optional shared live-run map.
 * @returns A `defineTool` tool object implementing the `loop` action surface.
 */
export function createLoopTool(options: LoopToolOptions): ReturnType<typeof defineTool> {
  const runs = options.runs ?? new Map<string, LoopRun>()
  const scopeOf = (sid: string): RlmScope => ({ kind: 'session', id: sid })

  return defineTool({
    name: 'loop',
    description:
      'Loop Engineering bookkeeping for a Manage→Execute→Audit run. `begin` opens a run ' +
      '(call once with task + contract). After each auditor verification, `record` the round: ' +
      'the three-line audit header is parsed deterministically and only a clean/complete/aligned ' +
      'verdict lands as verified progress (a store judgment — the harness projection picks it up). ' +
      '`status` shows the current run.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: "One of 'begin', 'record', 'status'",
      },
      task: {
        type: 'string',
        description: '(begin) The original user task verbatim',
      },
      contract: {
        type: 'string',
        description:
          '(begin) Stable task contract: target end state, authoritative inputs, acceptance constraints',
      },
      round: {
        type: 'integer',
        description: '(record) Round number, starting at 1',
      },
      route: {
        type: 'string',
        description: '(record) The manager route taken this round: gui | cli | done | blocked | ask',
      },
      audit_report: {
        type: 'string',
        description: '(record) The full auditor report including its first three verdict lines',
      },
      progress_note: {
        type: 'string',
        description:
          '(record) One verified-fact summary to land as trusted progress; required when you want a clean audit recorded as progress',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          runId: { type: 'string' },
          round: { type: 'integer' },
          accepted: { type: 'boolean' },
          status: { type: 'string' },
          integrity: { type: 'string' },
          contractAudit: { type: 'string' },
          landed: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec): Promise<LoopToolResult> {
      const { sid, session } = sessionIdOf(exec)
      if (!sid) throw new Error('loop: requires an owning agent session')
      const action = typeof args.action === 'string' ? args.action : ''
      void session // session identity is carried by the store scope + payloads

      if (action === 'begin') {
        const task = typeof args.task === 'string' ? args.task.trim() : ''
        if (!task) throw new Error('loop begin: task is required')
        const contract = typeof args.contract === 'string' ? args.contract.trim() : ''
        const previous = runs.get(sid)
        const runId = `loop_${randomUUID().slice(0, 8)}`
        // The action boundary is the run's durable anchor; the projection
        // renders its contract into the harness overview from this event.
        const begin = await options.store.append(scopeOf(sid), 'rlm/action-boundary', {
          action: 'loop-begin',
          runId,
          task,
          contract,
        })
        runs.set(sid, { runId, task, contract, beginSeq: begin.seq, rounds: [] })
        const superseded = previous
          ? ` Previous run ${previous.runId} (${previous.rounds.length} recorded rounds) is replaced; its durable facts stay in the store stream.`
          : ''
        return {
          text: `Loop run ${runId} opened${contract ? '' : ' (no contract given — auditors will score Contract audit against an unknown target)'}.`
            + `${superseded} `
            + 'Per round: call the executor delegation tool with ONE bounded subtask, then the auditor tool, '
            + 'then `loop` action=record with round/route/audit_report. Only clean audits become progress.',
          runId,
        }
      }

      if (action === 'record') {
        const run = runs.get(sid)
        if (!run) throw new Error('loop record: no active run — call action=begin first')
        const round = typeof args.round === 'number' && Number.isInteger(args.round) && args.round >= 1
          ? args.round
          : 0
        if (round === 0) throw new Error('loop record: round must be a positive integer')
        // A duplicate round must not double-count progress or double-land the
        // earlier round's belief.
        if (run.rounds.some(entry => entry.round === round)) {
          return {
            text: `Round NOT recorded: round ${round} was already recorded in run ${run.runId}. `
              + 'Retrying a round is fine, but record the RETRY as a new round number; nothing was trusted twice.',
            runId: run.runId,
            round,
            accepted: false,
            status: 'duplicate',
            integrity: 'suspect',
            contractAudit: 'unknown',
            landed: false,
          }
        }
        const route = typeof args.route === 'string' ? args.route.trim() : ''
        if (!ROUTES.has(route)) throw new Error(`loop record: route must be one of ${[...ROUTES].join(' | ')}`)
        const report = typeof args.audit_report === 'string' ? args.audit_report : ''
        const header = parseAuditHeader(report)
        if (!header) {
          return {
            text: 'Round NOT recorded: the report does not start with the ordered three-line header '
              + '`Status: complete|incomplete|blocked`, `Integrity: clean|suspect|violation`, '
              + '`Contract audit: aligned|unknown|needs_revision|invalid`. Re-run the auditor; nothing was trusted.',
            runId: run.runId,
            round,
            accepted: false,
            status: 'unparsed',
            integrity: 'suspect',
            contractAudit: 'unknown',
            landed: false,
          }
        }
        const accepted = isCleanComplete(header)
        const note = typeof args.progress_note === 'string' ? args.progress_note.trim() : ''

        // The action boundary for the round lands first, so the judgment's
        // provenance range [begin, record] is locatable in the stream.
        const record = await options.store.append(scopeOf(sid), 'rlm/action-boundary', {
          action: 'loop-record',
          runId: run.runId,
          round,
          route,
          status: header.status,
          integrity: header.integrity,
          contractAudit: header.contract,
          accepted,
        })

        // The audit IS a check judgment: object = the state (this round's
        // progress claim), criterion = the three-line header protocol. Both
        // outcomes land as events — check-doubt touches no belief (density
        // accounting never mistakes a pass for absence).
        let landed = false
        try {
          await options.store.judge(scopeOf(sid), {
            criterionRef: 'crit/loop-three-line-header',
            verdict: accepted ? 'check-pass' : 'check-doubt',
            ...(accepted && note
              ? {
                belief: {
                  kind: 'procedural' as const,
                  content: note,
                  title: `[loop] Verified progress (${run.runId} round ${round})`,
                  subject: run.runId,
                  basedOn: [] as string[],
                  lastVerified: { channel: 'loop-three-line-header', eventPos: record.seq },
                },
              }
              : {}),
            dataSupport: {
              summary: `audit round ${round}: ${header.status}/${header.integrity}/${header.contract}`,
              ...(report ? { refs: [`audit_report:${report.slice(0, 200)}`] } : {}),
            },
            provenance: { eventRange: [run.beginSeq, record.seq] },
          })
          landed = accepted && note !== ''
        } catch (error) {
          // The action boundary is durable; a judgment refusal is surfaced so
          // the verdict is not lost silently.
          console.warn(`[rlm-loop] judgment refused for run ${run.runId} round ${round}:`, error)
        }

        run.rounds.push({
          round,
          route,
          accepted,
          status: header.status,
          integrity: header.integrity,
          contractAudit: header.contract,
        })
        const lines: string[] = []
        lines.push(accepted
          ? `Round ${round} recorded as VERIFIED progress (${header.status}/${header.integrity}/${header.contract}).`
          : `Round ${round} recorded but NOT trusted (${header.status}/${header.integrity}/${header.contract}); treat its output as failure evidence for planning.`)
        if (accepted && !note) {
          lines.push('Warning: verdict is clean but no progress_note given — nothing was landed as a belief.')
        }
        if (route === 'done' && !accepted) {
          lines.push('Route done REJECTED: completion requires Status complete AND Integrity clean AND Contract audit aligned.')
        }
        if (route === 'done' && accepted && !landed && note) {
          lines.push('Warning: done declared but the progress belief failed to land — re-record before finishing.')
        }
        if (round > options.maxRounds) {
          lines.push(`Warning: round ${round} exceeds the configured soft ceiling of ${options.maxRounds} rounds.`)
        }
        lines.push(landed
          ? 'Verified progress is durable as a store belief and renders into future context via the harness projection.'
          : 'No belief landed this round.')
        return {
          text: lines.join(' '),
          runId: run.runId,
          round,
          accepted,
          status: header.status,
          integrity: header.integrity,
          contractAudit: header.contract,
          landed,
        }
      }

      if (action === 'status') {
        const run = runs.get(sid)
        if (!run) return { text: 'No active loop run in this session. Call action=begin to open one.' }
        const verified = run.rounds.filter(r => r.accepted)
        return {
          text: `Run ${run.runId}: ${run.rounds.length} recorded rounds, ${verified.length} verified`
            + (verified.length > 0 ? ` (rounds ${verified.map(r => r.round).join(', ')})` : '')
            + `. Task: ${run.task.slice(0, 200)}${run.task.length > 200 ? '…' : ''}`,
          runId: run.runId,
        }
      }

      throw new Error("loop: unknown action — use 'begin', 'record', or 'status'")
    },
  })
}
