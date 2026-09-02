/**
 * Continual harness plugin.
 *
 * Injects the harness overview (persistent instructions / memories / skills /
 * subagents) into every assembled system prompt. Since the Phase A authority
 * flip (BUILD.md) the local `harness_state.json` is a PROJECTION of the
 * session's unified-store view: producers write the store, the change
 * listener here re-renders the file, and the prompt renderer reads it
 * synchronously as before. `/refine` is frozen until its Phase B
 * channelization; the global-scope file is frozen read-only until the Phase C
 * mailbox migration.
 * @module @deepseek-ai/dsh-plugin-continual-harness
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export { HarnessConflictError, globalHarnessStatePath, harnessStatePath, readHarnessStateDetailed, readHarnessStatesDetailed, writeHarnessStates } from './harness-file.ts';
export type { HarnessEntry, HarnessStateFile, RefinementEvent } from './harness-file.ts';
export declare const name = "plugin-continual-harness";
export declare const inject: string[];
/**
 * Configuration for the continual harness plugin: where harness state lives,
 * how much of it renders into the prompt, and how `/refine` behaves.
 */
export interface Config {
    /** Root directory for harness state. Defaults to `~/.dsh/rlm` — must match plugin-rlm-kernel. */
    dataDir?: string;
    /**
     * Per-kind cap when rendering the harness overview into the prompt.
     * Defaults to 6, mirroring prime-agent's hints-only injected overview
     * (`DEFAULT_OVERVIEW_ENTRY_LIMIT`): surface routing hints, not the full
     * harness; the model reads underlying entries on demand.
     */
    maxEntriesPerKind?: number;
    /**
     * Per-entry content cap when rendering the harness overview (FIX-10).
     * Defaults to 180, mirroring prime-agent's `CONTENT_LIMIT`: truncate each
     * entry to a hint, keeping the id/tag/title visible for reference.
     */
    maxCharsPerEntry?: number;
    /**
     * Total character ceiling for the whole harness overview section (FIX-10).
     * Defaults to 6000 — a bounded routing index across the four kinds.
     */
    maxTotalChars?: number;
    /**
       * Subagent provider used by `/refine`. Must name a registered provider
       * (FIX-1: this used to be the hard-coded string `'refine'`, which no
       * provider is registered under). Defaults to `'spawn'`, matching
       * plugin-rlm-kernel's `subagentProvider`.
       */
    refineProvider?: string;
    /**
       * How many `RefinementEvent`s (and their snapshot files) are retained per
       * session before the oldest are pruned (item-10). Defaults to 100.
       */
    maxRefinementEvents?: number;
    /**
     * Automatic refinement scheduler (P0): trigger `/refine` from root-agent turn
     * completions after a turn-interval and cooldown gate, gated by an independent
     * review LLM. Disabled by default; opt in explicitly.
     */
    autoRefine?: boolean;
    /** Minimum root-agent turns between automatic refine reviews. Defaults to 12. */
    autoRefineTurnInterval?: number;
    /** Minimum wall-clock gap (ms) between automatic refine reviews. Defaults to 600000. */
    autoRefineCooldownMs?: number;
    /**
     * T7.13 (LAYERS.md §3): active recall injection at harness section render.
     * `off` does nothing; `observe` (default) runs the recall and records a
     * `session/memory-recall-inject` event WITHOUT touching the prompt; `enforce`
     * actually injects the top-N recall section. The query is the most recent
     * user message; hits come from the memory package's published store under
     * `<dataDir>/memory`.
     */
    recallInject?: 'off' | 'observe' | 'enforce';
    /** T7.13: how many ranked hits the recall section may carry. Defaults to 3. */
    recallInjectTopN?: number;
    /** T7.13: hard budget (chars) for the whole injected recall section. Defaults to 2000. */
    recallInjectBudgetChars?: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map