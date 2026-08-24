/**
 * `/moa` management command handlers: list / show / use / remove. Pure
 * functions over the layered preset view and the managed store file, so the
 * Cordis command registration in index.ts stays a thin switch.
 *
 * `use` persists the active default pointer; `remove` only deletes
 * store-managed presets — Config-sourced presets are immutable here.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-moa/moa-cmd
 */

import { loadPresetStoreSync, savePresetStoreSync, type PresetView } from './preset-store.ts'

/** `/moa list`: every preset with its default marker and slot summary. */
export function listMoaPresetsText(view: PresetView): string {
  const defaultName = view.defaultName()
  const lines: string[] = []
  for (const name of view.available()) {
    const preset = view.resolve(name)
    const marker = name === defaultName ? ' [default]' : ''
    const refs = preset.references.map(r => r.label).join(', ')
    lines.push(`- ${name}${marker}\n    refs (${preset.references.length}): ${refs}\n    aggregator: ${preset.aggregator.label}`)
  }
  return lines.length > 0 ? lines.join('\n') : '(no moa presets)'
}

/** `/moa show <name>`: full slot detail for one preset. */
export function showMoaPresetText(view: PresetView, name: string): string {
  let preset: MoaResolvedPresetLike
  try {
    preset = view.resolve(name)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return [
    `moa preset "${preset.name}"`,
    ...preset.references.map(r => `- ref ${r.label} (${r.provider})`),
    `- aggregator ${preset.aggregator.label} (${preset.aggregator.provider})`,
    `referenceMaxTokens: ${preset.referenceMaxTokens}  referenceTimeoutMs: ${preset.referenceTimeoutMs}  degradedPolicy: ${preset.degradedPolicy}`,
  ].join('\n')
}

interface MoaResolvedPresetLike {
  name: string
  references: Array<{ label: string; provider: string }>
  aggregator: { label: string; provider: string }
  referenceMaxTokens: number
  referenceTimeoutMs: number
  degradedPolicy: string
}

/**
 * `/moa use <name>`: persist the active default pointer into the managed
 * store. The name must already exist in the merged view (Config or store).
 */
export function useMoaPresetDefault(storePath: string, view: PresetView, name: string): string {
  if (!view.available().includes(name)) {
    return `Unknown preset "${name}". Available presets: ${view.available().join(', ')}`
  }
  const store = loadPresetStoreSync(storePath)
  savePresetStoreSync(storePath, { ...store, defaultPreset: name })
  return `Default moa preset is now "${name}" (persisted).`
}

/**
 * `/moa remove <name>`: delete one store-managed preset. Config-sourced
 * presets cannot be removed here — the command says so instead of failing.
 */
export function removeManagedMoaPreset(storePath: string, name: string): string {
  const store = loadPresetStoreSync(storePath)
  if (store.presets === undefined || !(name in store.presets)) {
    return `"${name}" is not a store-managed preset (presets from plugin Config cannot be removed via /moa remove)`
  }
  const remaining = { ...store.presets }
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete remaining[name]
  savePresetStoreSync(storePath, { ...store, presets: remaining })
  return `Removed managed preset "${name}".`
}
