/**
 * `/harness` management command (item-5): list / show harness entries without
 * writing a proposal subagent. Mutations are frozen in Phase A — the file is
 * a store projection now (see ./projection.ts).
 * @module @deepseek-ai/dsh-plugin-continual-harness
 */
import { globalHarnessStatePath, harnessStatePath, mergeHarnessStates, readHarnessStateSync, } from "./harness-file.js";
const KINDS = ['prompt', 'memory', 'skill', 'subagent'];
const KIND_SET = new Set(KINDS);
function readMergedSync(baseDir, sessionId) {
    return mergeHarnessStates(readHarnessStateSync(globalHarnessStatePath(baseDir)), readHarnessStateSync(harnessStatePath(baseDir, sessionId)));
}
/**
 * Resolve an id selector (exact id or a unique prefix) across every kind and
 * scope in the merged view. Ambiguous or unmatched selectors are errors.
 */
function resolveEntry(state, selector) {
    const matches = [];
    for (const kind of KINDS) {
        for (const entry of Object.values(state.entries[kind] ?? {})) {
            if (entry.id === selector || entry.id.startsWith(selector))
                matches.push({ kind, entry });
        }
    }
    if (matches.length === 0)
        return `No harness entry matches "${selector}"`;
    if (matches.length > 1) {
        return `"${selector}" is ambiguous (${matches.length} matches); use a longer id prefix`;
    }
    const match = matches[0];
    if (!match)
        return `No harness entry matches "${selector}"`;
    return match;
}
function byUpdatedDesc(a, b) {
    return String(b.updated_at ?? b.created_at).localeCompare(String(a.updated_at ?? a.created_at));
}
/**
 * `/harness list [kind]`: all entries, newest first, full ids, scope markers.
 * @param baseDir - the workspace root used to locate harness state files.
 * @param sessionId - the session whose scoped entries are merged in.
 * @param kind - optional kind filter (`prompt`/`memory`/`skill`/`subagent`); lists all when omitted.
 * @returns a human-readable listing of harness entries, or an error string for an unknown kind.
 */
export function listHarness(baseDir, sessionId, kind) {
    if (kind !== undefined && !KIND_SET.has(kind)) {
        return `Unknown harness kind "${kind}" (${KINDS.join('|')})`;
    }
    const merged = readMergedSync(baseDir, sessionId);
    const lines = [];
    for (const k of KINDS) {
        if (kind !== undefined && k !== kind)
            continue;
        const entries = Object.values(merged.entries[k] ?? {});
        if (entries.length === 0)
            continue;
        lines.push(`## ${k} (${entries.length})`);
        for (const entry of [...entries].sort(byUpdatedDesc)) {
            const content = entry.content.length > 120 ? entry.content.slice(0, 120) + '…' : entry.content;
            const scope = entry.scope === 'global' ? ' [global]' : '';
            lines.push(`- ${entry.id}${scope} ${entry.title}: ${content}`);
        }
    }
    return lines.length > 0 ? lines.join('\n') : '(harness empty)';
}
/**
 * `/harness show <id>`: full detail for one entry.
 * @param baseDir - the workspace root used to locate harness state files.
 * @param sessionId - the session whose scoped entries are merged in.
 * @param selector - exact id or unique id prefix of the entry to display.
 * @returns a formatted detail block for the resolved entry, or an error string.
 */
export function showHarnessEntry(baseDir, sessionId, selector) {
    const resolved = resolveEntry(readMergedSync(baseDir, sessionId), selector);
    if (typeof resolved === 'string')
        return resolved;
    const entry = resolved.entry;
    const meta = JSON.stringify(entry.metadata ?? {});
    return [
        `${resolved.kind} [${entry.scope}] #${entry.id} (v${entry.version})`,
        `title: ${entry.title}`,
        `source: ${entry.source}  created: ${entry.created_at}  updated: ${entry.updated_at}`,
        ...(meta && meta !== '{}' ? [`metadata: ${meta}`] : []),
        'content:',
        entry.content,
    ].join('\n');
}
//# sourceMappingURL=harness-cmd.js.map