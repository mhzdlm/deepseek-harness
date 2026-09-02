/**
 * Filesystem discovery of agent presets. A preset is a directory holding
 * {@link COMPOSITION_FILE}, optionally beside a {@link METADATA_FILE} carrying
 * its display text; the directory name is the preset id. Discovery
 * re-reads the roots on every call so a preset authored while the process is
 * running is visible without a restart.
 *
 * Discovery also owns preset HEALTH: a directory whose composition is
 * missing or unloadable is reported as a broken roster row rather than
 * skipped. A skipped directory would still occupy its id on disk — the copy
 * path refuses the name while no surface shows anything to delete — and a
 * malformed composition would otherwise read as an ordinary preset until the
 * first session fails to mount it.
 *
 * Health is what every consumer reads before offering a preset — the pickers
 * drop a broken row rather than defer the discovery to a failed session
 * start — so it covers the way an authored preset actually rots: a row naming
 * a package that was renamed or uninstalled. Resolving those names is a
 * separate pass from the shape check and stops short of importing anything,
 * so a composition is judged without running a line of plugin code.
 * @module @deepseek-ai/dsh-agent-presets/discovery
 */
import { type AgentPreset, type PresetRoot } from './preset.ts';
/** The composition file that makes a directory a preset. */
export declare const COMPOSITION_FILE = "agent.cordis.yml";
/**
 * Harness-home directory holding locally authored presets.
 *
 * This package owns the writable root the way `dsh-skill-filesystem` owns
 * `<dshHome>/skills`: where a person's own presets go is the same place in
 * every deployment that does not say otherwise, so a launcher that forgets to
 * configure one still finds them.
 *
 * Package-internal on purpose: no consumer outside this package addresses the
 * directory by name, and a test that imported it could not catch this value
 * being wrong — the expected segment is spelled out where it is asserted.
 */
export declare const USER_PRESET_DIR = ".agent-presets";
/**
 * The shipped presets, bundled inside this package: the roster's built-in
 * compositions travel with the machinery that mounts them, the way each
 * preset's own skills travel inside its directory. Resolved relative to this
 * module so both launch layouts work — `src/` under tsx and the bundled
 * `lib/` sit one level below the package root.
 */
export declare const SHIPPED_PRESET_ROOT: string;
/**
 * Why `rows` cannot be an entry list, or undefined when it can.
 *
 * A shallow shape check, deliberately short of the loader's work: it does not
 * resolve plugin names or apply configs. What it catches is the hand-edit
 * that produces a file the loader cannot even begin with — and it must accept
 * everything the loader accepts, which is why rows are only required to be
 * maps carrying a plugin `name` (groups recurse into their own lists).
 *
 * Shared with the composition inventory, whose file reads race edits against
 * the health verdict and must judge the raced content by the same rule.
 * @param rows - the parsed composition document.
 * @param at - row-path prefix for nested diagnostics, empty at the top level.
 * @returns one human-readable reason, or undefined when the shape holds.
 */
export declare function entryListProblem(rows: unknown, at?: string): string | undefined;
/**
 * Whether one classified row names a module that exists, importing nothing.
 *
 * Each kind is checked by what actually answers it. A package name is looked
 * up on disk — the same upward walk Node's own resolver starts with — and a
 * relative or `file:` specifier is statted, because both name one file.
 * Nothing is evaluated either way, so a row is judged without its plugin
 * observing that discovery looked.
 *
 * `import.meta.resolve` is deliberately not the fallback for a name the disk
 * lookup misses. Its `parentURL` argument only takes effect under
 * `--experimental-import-meta-resolve`, which no launch passes, so it would
 * resolve from THIS module rather than from the harness — reporting a
 * dependency visible only to this package as healthy, and a plugin the mount
 * can import as broken. The resolver that does honour an explicit parent is
 * the Loader's internal one, whose `resolveSync` signature differs between
 * Node 22 and 24 (`ModuleLoader.fromInternal` tags the raw object rather than
 * normalising it); reaching into that for a case the walk already covers buys
 * nothing a supported deployment needs, because every plugin a preset names
 * is installed beside the roster.
 *
 * What that gives up: a package resolvable ONLY through a loader hook — an
 * import map, or a tree with no `node_modules` at all — is reported broken.
 * No supported install produces one.
 * @param row - the classified specifier, from {@link classifyRowSpecifier}.
 * @param presetBase - directory URL a preset-relative specifier resolves against.
 * @param harnessBase - base URL a package name resolves against.
 * @returns true when the row names something that can be imported.
 */
/**
 * Secondary resolver for a bare package name, consulted only when the
 * `node_modules` disk walk (`packageInstalled`) misses.
 *
 * The walk is authoritative for an installed harness, where every preset row's
 * package is hoisted beside the roster, so this resolver is never reached
 * there. A dev checkout run through a workspace package manager that does not
 * hoist workspace packages leaves the walk empty even though the same bare name
 * resolves through the host module resolver — Vite's tsconfig paths in this
 * suite. A caller that knows such a resolver passes it here; it runs only after
 * the walk fails, so a real install is unaffected and a genuinely uninstalled
 * package still reports broken.
 * @param name - the package specifier, possibly carrying a subpath.
 * @param base - the base URL the package name resolves against.
 * @returns true when the resolver can locate the module.
 */
export type ModuleResolver = (name: string, base: string) => boolean | Promise<boolean>;
/**
 * Scan one root for preset directories.
 *
 * An absent root yields no presets rather than throwing: the user root does
 * not exist until the first locally authored preset, and naming a default
 * that no root supplies already fails loud at resolution.
 *
 * Every directory whose name is a usable preset id is a roster row — broken
 * when its composition is missing or unloadable. A directory named outside
 * {@link PRESET_ID} is skipped instead: no copy could ever claim that name,
 * so it blocks nothing, and reporting `.DS_Store`-grade residue as broken
 * presets would teach users to ignore the marker.
 * @param root - the directory and the trust its presets inherit.
 * @param harnessBase - base URL a row's package name resolves against; the
 * caller's own `ctx.baseUrl`, which is where the installed harness lives.
 * @returns the root's presets ordered by id.
 */
export declare function scanRoot(root: PresetRoot, harnessBase: string, moduleResolver?: ModuleResolver): Promise<AgentPreset[]>;
/**
 * Scan every root in precedence order.
 * @param roots - roots in precedence order; an earlier root wins a duplicate id.
 * @param harnessBase - base URL a row's package name resolves against.
 * @returns every discovered preset, first-root-wins per id.
 */
export declare function discoverPresets(roots: readonly PresetRoot[], harnessBase: string, moduleResolver?: ModuleResolver): Promise<AgentPreset[]>;
//# sourceMappingURL=discovery.d.ts.map