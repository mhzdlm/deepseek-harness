/**
 * The `loop` tool: Loop Engineering bookkeeping for a model-driven
 * Manage→Execute→Audit run. The joining session IS the manager — episodes ride
 * the composition-provided executor/auditor delegation tools — so this tool
 * owns only what must not depend on model compliance:
 *
 * - deterministic parsing of the auditor's three-line report header,
 * - the trust gate (only clean+complete+aligned rounds become progress),
 * - durable `session/loop-*` process events,
 * - CAS landing of the task contract and verified progress into harness state.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-loop/loop-tool
 */

import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import { emitLoopEvent } from './events.ts'
import { isCleanComplete, parseAuditHeader } from './parse.ts'
import { upsertMemoryEntry } from './state.ts'

export interface LoopToolOptions {
  /** Harness base dir; must match plugin-continual-harness's `dataDir`. */
  dataDir: string
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

export interface LoopRun {
  runId: string
  task: string
  contract: string
  rounds: RecordedRound[]
}

const ROUTES = new Set(['gui', 'cli', 'done', 'blocked', 'ask'])

/** Tool-facing result of one `loop` call. */
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

/** Build the `loop` tool around harness state at {@link LoopToolOptions.dataDir}. */
export function createLoopTool(options: LoopToolOptions) {
  const runs = options.runs ?? new Map<string, LoopRun>()

  async function landEntry(sid: string, id: string, title: string, content: string): Promise<boolean> {
    try {
      await upsertMemoryEntry(options.dataDir, sid, { id, title, content })
      return true
    } catch {
      return false
    }
  }

  return defineTool({
    name: 'loop',
    description:
      'Loop Engineering bookkeeping for a Manage→Execute→Audit run. `begin` opens a run ' +
      '(call once with task + contract). After each auditor verification, `record` the round: ' +
      'the three-line audit header is parsed deterministically and only a clean/complete/aligned ' +
      'verdict lands as verified progress. `status` shows the current run.',
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

      if (action === 'begin') {
        const task = typeof args.task === 'string' ? args.task.trim() : ''
        if (!task) throw new Error('loop begin: task is required')
        const contract = typeof args.contract === 'string' ? args.contract.trim() : ''
        const previous = runs.get(sid)
        const runId = `loop_${randomUUID().slice(0, 8)}`
        // One live run per session; the plugin assembly evicts entries on
        // session disposal, so replaced runs drop out here via the set below.
        runs.set(sid, { runId, task, contract, rounds: [] })
        emitLoopEvent(session, 'session/loop-start', {
          runId,
          taskChars: task.length,
          contractChars: contract.length,
        })
        let landed = true
        if (contract) {
          landed = await landEntry(
            sid,
            `${runId}/contract`,
            `[loop] Task contract (${runId})`,
            `[Task contract]\n${contract}\n\n[Original task]\n${task}`,
          )
        }
        const superseded = previous
          ? ` Previous run ${previous.runId} (${previous.rounds.length} recorded rounds) is replaced; its durable facts stay in the session log and harness state.`
          : ''
        return {
          text: `Loop run ${runId} opened${contract ? '' : ' (no contract given — auditors will score Contract audit against an unknown target)'}.`
            + `${superseded} `
            + 'Per round: call the executor delegation tool with ONE bounded subtask, then the auditor tool, '
            + 'then `loop` action=record with round/route/audit_report. Only clean audits become progress.'
            + (landed ? '' : ' Warning: contract landing into harness state failed; it stays in this conversation only.'),
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
        let landed = false
        if (accepted && note) {
          landed = await landEntry(
            sid,
            `${run.runId}/round_${String(round).padStart(3, '0')}`,
            `[loop] Verified progress (${run.runId} round ${round})`,
            `[Verified via audit round ${round}: ${header.status}/${header.integrity}/${header.contract}]\n${note}`,
          )
        }
        run.rounds.push({
          round,
          route,
          accepted,
          status: header.status,
          integrity: header.integrity,
          contractAudit: header.contract,
        })
        emitLoopEvent(session, 'session/loop-round-done', {
          runId: run.runId,
          round,
          route,
          status: header.status,
          integrity: header.integrity,
          contractAudit: header.contract,
          accepted,
          landed,
          noteChars: note.length,
        })
        const lines: string[] = []
        lines.push(accepted
          ? `Round ${round} recorded as VERIFIED progress (${header.status}/${header.integrity}/${header.contract}).`
          : `Round ${round} recorded but NOT trusted (${header.status}/${header.integrity}/${header.contract}); treat its output as failure evidence for planning.`)
        if (accepted && !note) {
          lines.push('Warning: verdict is clean but no progress_note given — nothing was landed into harness state.')
        }
        if (route === 'done' && !accepted) {
          lines.push('Route done REJECTED: completion requires Status complete AND Integrity clean AND Contract audit aligned.')
        }
        if (route === 'done' && accepted && !landed && note) {
          lines.push('Warning: done declared but the progress entry failed to land in harness state — re-record before finishing.')
        }
        if (round > options.maxRounds) {
          lines.push(`Warning: round ${round} exceeds the configured soft ceiling of ${options.maxRounds} rounds.`)
        }
        lines.push(landed
          ? 'Verified progress is durable in harness state and will be injected into future context.'
          : 'No harness-state change this round.')
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
