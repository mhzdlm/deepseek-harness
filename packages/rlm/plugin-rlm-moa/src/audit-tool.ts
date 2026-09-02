/**
 * The `rlm_audit` tool: Phase D reverse-filtering (ARCHITECTURE.md §7) wired
 * onto the moa model seam. The critic slot comes from plugin config
 * (`audit.critic`) and MUST name a different model than the producer — the
 * store-side pipeline re-checks the constraint before any model call, this
 * layer resolves identities and fails loud when they cannot be verified.
 *
 * The pipeline itself (critic prompt, procedural arbitration, judgment
 * landing) lives in `@deepseek-ai/dsh-plugin-rlm-store/audit`; this file is
 * transport and configuration only.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-moa/audit-tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { RlmScope, RlmStore } from '@deepseek-ai/dsh-plugin-rlm-store'
import { runAudit } from '@deepseek-ai/dsh-plugin-rlm-store'
import type { MoaResolvedSlot } from './presets.ts'
import type { MoaCallModel } from './moa-tool.ts'

/** Wiring for {@link createAuditTool}: store service, model seam, and the configured critic identity. */
export interface AuditToolOptions {
  /** Unified store; absent fails the tool loud (an audit without the stream is meaningless). */
  store?: RlmStore | undefined
  callModel: MoaCallModel
  /** Resolved critic slot from `audit.critic` config; undefined disables the tool with guidance. */
  critic?: MoaResolvedSlot | undefined
  /** Configured producer-model baseline (`audit.producerModel`). */
  producerModel?: string | undefined
  /** Critic call wall-clock budget in ms. */
  timeoutMs: number
}

/**
 * Build the `rlm_audit` tool around the given options.
 * @param options - store service, model seam, and critic identity.
 * @returns the configured `rlm_audit` tool instance for registration.
 */
export function createAuditTool(options: AuditToolOptions): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'rlm_audit',
    description:
      'Audit one belief through the reverse-filtering pipeline: an independent ' +
      'critic (a DIFFERENT model than the producer) raises objections, and a ' +
      'procedural arbiter validates their form. A clean audit lands a ' +
      'check-pass; an accepted objection demotes or voids the belief; a ' +
      'rejected objection freezes its trust-gate eligibility (no promotion, ' +
      'no merge, no publish) until a human batch review releases it.',
    parameters: {
      beliefId: {
        type: 'string',
        required: true,
        description: 'The belief id to audit (from the session projection or /memory stats)',
      },
      scope: {
        type: 'string',
        description: "'session' (default, this session) or 'mailbox'",
      },
      producerModel: {
        type: 'string',
        description:
          'Model identity that produced the belief; defaults to the configured ' +
          'audit.producerModel. The critic must differ from it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          beliefId: { type: 'string', required: true },
          outcome: { type: 'string', required: true },
          judgmentSeq: { type: 'number', required: true },
          failures: { type: 'array', items: { type: 'string' }, required: true },
          criticLabel: { type: 'string', required: true },
          reason: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const lines = [`rlm_audit [${value.criticLabel}] ${value.outcome} belief=${value.beliefId}`]
        if (value.judgmentSeq > 0) lines.push(`  judgment landed at seq ${value.judgmentSeq}`)
        if (value.reason !== '') lines.push(`  ${value.reason}`)
        for (const failure of value.failures) lines.push(`  arbiter: ${failure}`)
        if (value.outcome === 'objection-rejected-frozen') {
          lines.push('  frozen pending human review (/moa audit pending, /moa audit release <id> <note>)')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const store = options.store
      if (!store) throw new Error('rlm_audit: the rlm.store service is unavailable in this assembly')
      const critic = options.critic
      if (!critic) {
        throw new Error(
          'rlm_audit: no critic configured — set audit.critic {provider, model} in the plugin-rlm-moa ' +
            'configuration, naming a DIFFERENT model than the producer',
        )
      }
      const rawProducer = typeof args.producerModel === 'string' && args.producerModel.trim() !== ''
        ? args.producerModel
        : options.producerModel
      const producerModel = rawProducer?.trim()
      if (!producerModel) {
        throw new Error(
          'rlm_audit: the producer model is unknown — pass producerModel or configure audit.producerModel; ' +
            'without it the independence constraint cannot be verified',
        )
      }
      const sessionId = exec.agent?.session.id ? String(exec.agent.session.id) : undefined
      const sessionBranded = exec.agent?.session.id
      let scope: RlmScope
      if (args.scope === 'mailbox') {
        scope = { kind: 'mailbox' }
      } else {
        if (sessionId === undefined) throw new Error('rlm_audit: no owning session for the session scope')
        scope = { kind: 'session', id: sessionId }
      }
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(options.timeoutMs)])
      const result = await runAudit({
        store,
        scope,
        beliefId: args.beliefId,
        callCritic: request => options.callModel(critic, request, signal, 4_096, sessionBranded),
        producerModel,
        criticModel: critic.model,
        criticLabel: critic.label,
      })
      return {
        beliefId: result.beliefId,
        outcome: result.outcome,
        judgmentSeq: result.judgmentSeq ?? 0,
        failures: result.failures,
        criticLabel: result.criticLabel,
        reason: result.reason ?? '',
      }
    },
  })
}
