/**
 * Preset normalization for the MoA panel: named presets, each with a list of
 * reference slots and one aggregator slot.
 *
 * Normalization is total — it never throws on shape problems; callers that
 * need strict validation compare against {@link normalizePresets}' output
 * (empty reference lists and missing aggregators surface as resolution
 * errors naming the preset).
 *
 * @module @deepseek-ai/dsh-plugin-rlm-moa/presets
 */

/** Default provider route when a slot names none (harness built-in route). */
export const DEFAULT_SLOT_PROVIDER = 'deepseek-official'

/** The implicit preset created when the config declares none. */
export const DEFAULT_PRESET_NAME = 'default'

/** Ceiling applied to each reference answer unless a preset overrides it. */
export const DEFAULT_REFERENCE_MAX_TOKENS = 4_096

/** Per-reference wall-clock budget; an expired slot fails without failing the turn. */
export const DEFAULT_REFERENCE_TIMEOUT_MS = 120_000

/** One model slot: a provider route, a model id, optional bounds, and mode. */
export interface MoaSlotConfig {
  /**
   * Route name. In `llm` mode this is the registered LLM provider route;
   * in `subagent` mode it is the subagent provider name.
   */
  provider?: string
  /** Model id (`llm`) or child label hint (`subagent`). */
  model: string
  /** Disabled slots are skipped at fan-out time. Default true. */
  enabled?: boolean
  /** Execution mode: plain completion (default) or a spawned tool-capable subagent. */
  mode?: 'llm' | 'subagent'
}

/** A normalized, ready-to-run slot. `label` is the stable display identity. */
export interface MoaResolvedSlot {
  provider: string
  model: string
  label: string
  mode: 'llm' | 'subagent'
  /** True when `provider` was absent and the wiring layer should apply its own default. */
  providerFromDefault: boolean
}

/** A normalized preset ready for fan-out. */
export interface MoaResolvedPreset {
  name: string
  references: MoaResolvedSlot[]
  aggregator: MoaResolvedSlot
  referenceMaxTokens: number
  referenceTimeoutMs: number
  /** `loud` surfaces failed references to the aggregator; `quiet` drops them silently. */
  degradedPolicy: 'loud' | 'quiet'
}

function resolveSlot(raw: unknown): MoaResolvedSlot | null {
  if (typeof raw !== 'object' || raw === null) return null
  const slot = raw as { model?: unknown; mode?: unknown }
  const model = typeof slot.model === 'string' ? slot.model.trim() : ''
  if (!model) return null
  const rawProvider = (raw as { provider?: unknown }).provider
  const providerExplicit = typeof rawProvider === 'string' && rawProvider.trim().length > 0
  const provider = providerExplicit ? (rawProvider as string).trim() : DEFAULT_SLOT_PROVIDER
  const mode = slot.mode === 'subagent' ? 'subagent' : 'llm'
  const label = mode === 'subagent' ? `agent:${model}@${provider}` : `${model}@${provider}`
  return { provider, model, label, mode, providerFromDefault: !providerExplicit }
}

function normalizePreset(raw: unknown): Omit<MoaResolvedPreset, 'name'> | null {
  if (typeof raw !== 'object' || raw === null) return null
  const preset = raw as Record<string, unknown>
  const refsRaw = Array.isArray(preset.referenceModels) ? preset.referenceModels : []
  const enabled = refsRaw
    .filter(slot => typeof slot === 'object' && slot !== null && (slot as { enabled?: unknown }).enabled !== false)
    .map(slot => resolveSlot(slot))
    .filter((slot): slot is MoaResolvedSlot => slot !== null)
  const aggregator = resolveSlot(preset.aggregator)
  if (enabled.length === 0 || aggregator === null) return null
  const referenceMaxTokens =
    typeof preset.referenceMaxTokens === 'number' && Number.isFinite(preset.referenceMaxTokens)
      ? Math.max(1, Math.floor(preset.referenceMaxTokens))
      : DEFAULT_REFERENCE_MAX_TOKENS
  const referenceTimeoutMs =
    typeof preset.referenceTimeoutMs === 'number' && Number.isFinite(preset.referenceTimeoutMs)
      ? Math.max(1_000, Math.floor(preset.referenceTimeoutMs))
      : DEFAULT_REFERENCE_TIMEOUT_MS
  const degradedPolicy = preset.degradedPolicy === 'quiet' ? 'quiet' : 'loud'
  return { references: enabled, aggregator, referenceMaxTokens, referenceTimeoutMs, degradedPolicy }
}

/**
 * Build the built-in preset used when the deployment declares none: two
 * DeepSeek reference slots with distinct models plus a stronger aggregator,
 * all on the harness's own provider route.
 */
export function defaultPreset(): MoaResolvedPreset {
  return {
    name: DEFAULT_PRESET_NAME,
    references: [
      { provider: DEFAULT_SLOT_PROVIDER, model: 'deepseek-v4-flash', label: `deepseek-v4-flash@${DEFAULT_SLOT_PROVIDER}`, mode: 'llm', providerFromDefault: false },
      { provider: DEFAULT_SLOT_PROVIDER, model: 'deepseek-v4-pro', label: `deepseek-v4-pro@${DEFAULT_SLOT_PROVIDER}`, mode: 'llm', providerFromDefault: false },
    ],
    aggregator: { provider: DEFAULT_SLOT_PROVIDER, model: 'deepseek-v4-pro', label: `deepseek-v4-pro@${DEFAULT_SLOT_PROVIDER}`, mode: 'llm', providerFromDefault: false },
    referenceMaxTokens: DEFAULT_REFERENCE_MAX_TOKENS,
    referenceTimeoutMs: DEFAULT_REFERENCE_TIMEOUT_MS,
    degradedPolicy: 'loud',
  }
}

/**
 * Normalize the raw `presets` record into resolved presets keyed by name.
 * Invalid entries are dropped silently; a record that yields nothing falls
 * back to the single built-in preset.
 * @param raw - the `presets` value from plugin Config (may be undefined).
 * @returns presets by name and the name of the default entry.
 */
export function normalizePresets(raw: unknown): { presets: Map<string, MoaResolvedPreset>; defaultName: string } {
  const presets = new Map<string, MoaResolvedPreset>()
  if (typeof raw === 'object' && raw !== null) {
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      const clean = name.trim()
      if (!clean) continue
      const resolved = normalizePreset(value)
      if (resolved !== null) presets.set(clean, { name: clean, ...resolved })
    }
  }
  if (presets.size === 0) {
    const fallback = defaultPreset()
    presets.set(fallback.name, fallback)
    return { presets, defaultName: fallback.name }
  }
  const first = presets.keys().next().value as string
  return { presets, defaultName: first }
}
