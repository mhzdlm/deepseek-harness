/**
 * RLM memory plugin (ReMe's form, the Continual Harness paper's discipline,
 * dsh's sovereignty): Phase A write path. Captures completed root sessions,
 * sanitizes the transcript (strips tool results — anti-pollution, REME.md §5.1
 * D5), writes `dialog/<id>.jsonl`, spawns a host-owned extraction subagent that
 * proposes draft notes gated by an evidence locator (REME.md §5.1 D6), appends a
 * log-only `session/memory-captured` event (REME.md §5.1 D7), and exposes the
 * `/memory list|show|delete|consolidate|rollback|retire|archived|unretire` command
 * family (delete is drafts-only; published notes go through the Phase C promotion
 * gate and Phase D retirement below). Phase B (memory_search recall over `published/`) is implemented
 * here: an in-memory keyword index rebuilt from `published/` on each call (no
 * persisted `index/keyword.json` to drift, REME.md §5.2 / §10 Phase B acceptance),
 * the `memory_search` tool with the §8 D4 use-signal (increments `use_count`/
 * `last_accessed` per hit, never `version`), and a hints-only `agent/session-start`
 * guidance injection pointing the model at the tool (REME.md §6 D13). Phase C
 * (consolidation/gate/rollback) and Phase D (retire/archive, REME.md §5.4 D12) are
 * implemented: an aging scan scores `published/` notes by `use_count` + recency and a
 * reversible `archive/` move retires low-value stale notes under `exitMode: off|observe|enforce`
 * (default `off`, conservative — nothing retires unless enabled, REME.md §9).
 *
 * Capture accumulates per-session turns from the single `session/event` bus emit
 * (every `SessionEventMap` member reaches listeners through it), and flushes on
 * `session/disposed` — mirroring ReMe `runtime.capture` but host-owned.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-memory
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { MEMORY_EVENT_TYPES } from './events.ts';
import type { GateMode } from './consolidate.ts';
import type { ExitMode } from './retire.ts';
export type { GateMode };
export type { ExitMode };
export { search, hybridSearch } from './search.ts';
export type { SearchHit } from './search.ts';
/** Plugin manifest name, matching the npm package identifier. */
export declare const name = "plugin-rlm-memory";
/** Services this plugin requires at activation. */
export declare const inject: string[];
/** Capture timing mode (REME.md §9 `captureMode`). */
export type CaptureMode = 'off' | 'sessionEnd' | 'intervalTurns';
/** Privacy filter tier (REME.md §9 `privacyFilter`, mirrors moa's three tiers). */
export type PrivacyFilter = '' | 'display' | 'full';
/** Recall mode (REME.md §9, §12 open question 1). Phase B ships `'keyword'` only. */
export type RecallMode = 'keyword' | 'auto';
/** Embedding provider selection (REME.md §12.1 Phase E). */
export type EmbeddingProviderMode = 'off' | 'external';
/** Plugin configuration: where to store memory and how aggressively to capture/recall. */
export interface Config {
    /** Memory root; defaults to `~/.dsh/rlm/memory`. Subdirs created on first capture. */
    memoryDir?: string;
    /** When to capture: `off`, `sessionEnd` (default), or `intervalTurns`. */
    captureMode?: CaptureMode;
    /** Turn interval for `intervalTurns` mode (default 16). */
    captureIntervalTurns?: number;
    /** Only capture root (non-subagent) sessions (default true, REME.md §5.1 D5). */
    rootAgentsOnly?: boolean;
    /** `''` (off), `'display'`, or `'full'` credential/PII masking before the dialog lands. */
    privacyFilter?: PrivacyFilter;
    /** Default top-K for `memory_search` (default 5, REME.md §9/§10 Phase B acceptance). */
    recallTopK?: number;
    /** Recall mode: `'keyword'` (default) or `'auto'`. Phase B has no embeddings seam, */
    recallMode?: RecallMode;
    /** Guidance/UI language for the session-start hint: `'en'` (default) or `'zh'`. */
    language?: string;
    /**
     * Publish-gate mode (REME.md §5.3 D10, default `'observe'`): `off` no-op,
     * `observe` promote+flag, `enforce` promote only evidence-valid drafts.
     */
    gateMode?: GateMode;
    /** Growth budget: max published notes before promotion is skipped/rejected (default 200, REME.md §5.3 D2). */
    maxPublishedNotes?: number;
    /** Growth budget: max total bytes across `published/` (default 5_000_000, REME.md §5.3 D2). */
    maxPublishedBytes?: number;
    /**
     * Retirement exit mode (REME.md §5.4 D12 / §9 `exitMode`, default `'off'`):
     * conservative — nothing retires unless enabled. `off` no-op; `observe` logs
     * intent but does not move; `enforce` moves `published/` → `archived/` (reversible).
     */
    exitMode?: ExitMode;
    /**
     * Aging scan minimum age in days before a note can be a retire candidate
     * (default 180, REME.md §5.4/§9 — deliberately high so normal use never triggers).
     */
    agingMinAgeDays?: number;
    /** Aging scan minimum `use_count` to stay safe (default 1, REME.md §5.4/§9 — a note used even once is never retired). */
    agingMinUseCount?: number;
    /**
     * Embedding provider (REME.md §12.1 Phase E). `off` (default) keeps lexical-only
     * recall; `external` enables the OpenAI-compatible `ExternalEmbeddingProvider` (vector
     * + lexical hybrid recall). A dsh-native seam, when available, is a future provider on
     * the same `EmbeddingService` interface (no consumer change).
     */
    embeddingsProvider?: EmbeddingProviderMode;
    /** External embeddings base URL, e.g. `https://api.openai.com/v1` (OpenAI-compatible). */
    embeddingsBaseURL?: string;
    /** External embeddings API key; never committed. Falls back to `embeddingsApiKeyEnv`. */
    embeddingsApiKey?: string;
    /** Env var to read the API key from when `embeddingsApiKey` is empty (e.g. `DEEPSEEK_API_KEY`). */
    embeddingsApiKeyEnv?: string;
    /** External embeddings model id, e.g. `text-embedding-3-small`. */
    embeddingsModel?: string;
    /** Optional fixed embedding dimension; inferred from the first response when omitted. */
    embeddingsDim?: number;
    /** Max texts per embeddings request (batching); default 32. */
    embeddingsBatchSize?: number;
    /** Wall-clock budget per embeddings HTTP request (default 30_000); expiry degrades recall to lexical. */
    embeddingsTimeoutMs?: number;
    /** Wall-clock budget for the capture extraction child (default 120_000); expiry lands the dialog without drafts. */
    captureTimeoutMs?: number;
}
/** Schemastery schema validating {@link Config} at plugin load. */
export declare const Config: z<Config>;
/**
 * Activates the plugin: subscribes to the session bus to accumulate turns,
 * flushes+sanitizes+extracts on `session/disposed` (or at intervals), registers
 * `/memory`, registers the Phase B `memory_search` tool, and injects a hints-only
 * guidance message on `agent/session-start`.
 * @param ctx - Cordis context providing subagent, command, and session services.
 * @param config - the resolved plugin configuration.
 * @returns void
 */
export declare function apply(ctx: Context, config: Config): void;
/** Re-export the event-type constant so consumers import one symbol. */
export { MEMORY_EVENT_TYPES };
//# sourceMappingURL=index.d.ts.map