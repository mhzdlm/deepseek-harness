/**
 * RLM-specific compaction provider.
 *
 * `RlmSplitTurnCompactionEngine` extends the official `BasicCompactionEngine`
 * and overrides ONLY its single documented customization hook, `summarize()`.
 * Every other behavior — trigger policy, retention, the durable compaction
 * transaction, tool-pairing cut alignment, and the `compaction` service contract
 * — is inherited unchanged from `@deepseek-ai/dsh-compaction-basic`. The override
 * adds split-turn prefix summarization (P1-B) and keeps Files Touched parity
 * (P1-A) through a self-contained summarizer that does NOT import any private
 * symbol from `compaction-basic`.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-compaction
 */

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import type { ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic/src/types.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { summarizeRlm, priorFilesTouched, type ResolvedCompactionConfig } from './split-turn-summarizer.ts'

/**
 * RLM compaction backend: identical policy/transaction to `BasicCompactionEngine`,
 * with a split-turn-aware summarizer. Registered as `ctx.compaction`, so the
 * standard `command-compact` and `tool-result-pruner` consumers pick it up
 * automatically in an RLM preset that mounts this engine instead of
 * `compaction-basic`.
 *
 * The base class owns `Config`, `config`, and the automatic-compaction
 * registration (which dispatches through `this.summarize`, so this override is
 * the only behavior that changes). Nothing else is redeclared here.
 */
export class RlmSplitTurnCompactionEngine extends BasicCompactionEngine {
  /**
   * Resolve the summarization config for one agent, applying the matching
   * per-model policy override the same way `BasicCompactionEngine` does, without
   * depending on that package's private `resolveTargetPolicy`.
   * @param agent - agent whose routed/option target selects a policy override.
   * @returns the resolved summarization config (provider/model/maxTokens).
   */
  private resolvedSummarizationConfig(agent: Agent): ResolvedCompactionConfig {
    const base = this.config as ResolvedConfig
    const target = this.conversationTarget(agent)
    const policy = target === undefined
      ? undefined
      : base.modelPolicies.find(p => p.provider === target.provider && p.model === target.model)
    const merged = policy === undefined ? base : { ...base, ...policy }
    return {
      summarizationProvider: merged.summarizationProvider,
      summarizationModel: merged.summarizationModel,
      maxTokens: merged.maxTokens,
    } as ResolvedCompactionConfig
  }

  /**
   * Resolve the conversation target used to select a per-model policy override,
   * mirroring `BasicCompactionEngine`'s `conversationTarget`: the durably routed
   * request header wins, then the agent's own provider/model options.
   * @param agent - agent whose session/options supply the routing target.
   * @returns the selected provider/model, or undefined when neither is set.
   */
  private conversationTarget(agent: Agent): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
    const routed = agent.session.requestHeader()?.config
    if (routed !== undefined && routed.provider.length > 0 && routed.model.length > 0) {
      return { provider: routed.provider, model: routed.model }
    }
    if (agent.options.provider !== undefined && agent.options.provider.length > 0
      && agent.options.model !== undefined && agent.options.model.length > 0) {
      return { provider: agent.options.provider, model: agent.options.model }
    }
    return undefined
  }

  /**
   * RLM-specific summarizer. Delegates to {@link summarizeRlm}, which replicates
   * the official replay-aware prefix-cache protocol but adds the split-turn
   * prefix section and Files Touched parity.
   * @param input - replayed conversation prefix to condense.
   * @param agent - supplies routed-model history and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns the summary result with parsed files/turn-prefix metadata.
   */
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const config = this.resolvedSummarizationConfig(agent)
    const prior = priorFilesTouched(agent.session)
    const inputWithPrior = prior === undefined ? input : { ...input, priorFilesTouched: prior }
    return summarizeRlm(this.ctx, config, inputWithPrior, agent, signal)
  }
}

export default RlmSplitTurnCompactionEngine
