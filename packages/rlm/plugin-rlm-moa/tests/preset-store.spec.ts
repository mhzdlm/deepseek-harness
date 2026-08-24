/**
 * Managed-preset store and `/moa` command handler tests: layered merge
 * precedence, default-pointer persistence, corruption quarantine, and the
 * remove-only-managed rule. All filesystem work runs in per-test tmp roots.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPresetView, loadPresetStoreSync, savePresetStoreSync } from '../src/preset-store.ts'
import { listMoaPresetsText, removeManagedMoaPreset, showMoaPresetText, useMoaPresetDefault } from '../src/moa-cmd.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-moa-store-'))
  roots.push(root)
  return root
}

const CONFIG_PRESETS = {
  configOnly: { referenceModels: [{ model: 'cfg-ref' }], aggregator: { model: 'cfg-agg' } },
  shared: { referenceModels: [{ model: 'cfg-shared' }], aggregator: { model: 'cfg-shared-agg' } },
}
const MANAGED_PRESET = { referenceModels: [{ model: 'file-ref' }, { model: 'file-ref2' }], aggregator: { model: 'file-agg' } }

describe('preset view layering', () => {
  it('store presets override same-name Config presets; defaults resolve store > config > first', () => {
    const root = tmpRoot()
    const storePath = join(root, 'moa-presets.json')
    savePresetStoreSync(storePath, {
      presets: { shared: MANAGED_PRESET },
      defaultPreset: 'shared',
    })
    const view = createPresetView(CONFIG_PRESETS, 'configOnly', storePath)
    expect(view.available()).toEqual(['configOnly', 'shared'])
    expect(view.defaultName()).toBe('shared')
    const shared = view.resolve('shared')
    expect(shared.references[0]?.model).toBe('file-ref')
    expect(view.resolve().name).toBe('shared')
  })

  it('without a store pointer the Config default wins; an unknown Config default falls to first', () => {
    const root = tmpRoot()
    const view = createPresetView(CONFIG_PRESETS, undefined, join(root, 'moa-presets.json'))
    expect(view.defaultName()).toBe('configOnly')
    const strict = createPresetView(CONFIG_PRESETS, 'missing-default', join(root, 's.json'))
    expect(strict.defaultName()).toBe('configOnly')
  })

  it('a corrupted store file is quarantined and treated as empty', () => {
    const root = tmpRoot()
    const storePath = join(root, 'moa-presets.json')
    writeFileSync(storePath, '{ not json', 'utf8')
    const view = createPresetView(CONFIG_PRESETS, undefined, storePath)
    expect(view.available()).toEqual(['configOnly', 'shared'])
    // The original path is renamed aside with a timestamp suffix.
    expect(existsSync(storePath)).toBe(false)
    const quarantined = readdirSync(root).filter(name => name.startsWith('moa-presets.json.corrupt-'))
    expect(quarantined.length).toBe(1)
  })
})

describe('/moa command handlers', () => {
  it('use persists the default pointer and the view picks it up immediately', () => {
    const root = tmpRoot()
    const storePath = join(root, 'moa-presets.json')
    savePresetStoreSync(storePath, { presets: { managed: MANAGED_PRESET } })
    const view = createPresetView(CONFIG_PRESETS, undefined, storePath)

    const bad = useMoaPresetDefault(storePath, view, 'nope')
    expect(bad).toContain('Unknown preset')

    const ok = useMoaPresetDefault(storePath, view, 'managed')
    expect(ok).toContain('Default moa preset is now "managed"')
    expect(view.defaultName()).toBe('managed')
    expect(loadPresetStoreSync(storePath).defaultPreset).toBe('managed')
  })

  it('remove deletes only store-managed presets and refuses Config-sourced ones', () => {
    const root = tmpRoot()
    const storePath = join(root, 'moa-presets.json')
    savePresetStoreSync(storePath, { presets: { managed: MANAGED_PRESET } })
    const view = createPresetView(CONFIG_PRESETS, undefined, storePath)

    expect(removeManagedMoaPreset(storePath, 'configOnly')).toContain('not a store-managed preset')
    expect(removeManagedMoaPreset(storePath, 'managed')).toContain('Removed managed preset')
    expect(view.available()).toEqual(['configOnly', 'shared'])
  })

  it('list and show render slot summaries with a default marker', () => {
    const root = tmpRoot()
    const storePath = join(root, 'moa-presets.json')
    savePresetStoreSync(storePath, { presets: { managed: MANAGED_PRESET }, defaultPreset: 'managed' })
    const view = createPresetView(CONFIG_PRESETS, undefined, storePath)

    const listing = listMoaPresetsText(view)
    expect(listing).toContain('- managed [default]')
    expect(listing).toContain('refs (2): file-ref@deepseek-official, file-ref2@deepseek-official')

    const detail = showMoaPresetText(view, 'configOnly')
    expect(detail).toContain('moa preset "configOnly"')
    expect(detail).toContain('- ref cfg-ref@deepseek-official')
    expect(detail).toContain('degradedPolicy: loud')

    const missing = showMoaPresetText(view, 'ghost')
    expect(missing).toContain("unknown preset 'ghost'")
  })
})
