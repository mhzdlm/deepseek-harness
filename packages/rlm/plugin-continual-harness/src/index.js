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
import { homedir } from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { globalHarnessStatePath, harnessStatePath, mergeHarnessStates, readHarnessStateSync } from "./harness-file.js";
import { latestUserQuery, renderRecallSection } from "./recall-inject.js";
// Phase 8 (review round 6): import through the memory package's compiled entry.
// The previous specifier (`@deepseek-ai/dsh-plugin-rlm-memory/src/search.ts`)
// was copied verbatim into this file's lib/ build output, and plain Node
// cannot execute a `.ts` import from node_modules — the built plugin failed to
// load outside tsx/monorepo resolution. The memory package now re-exports
// `search` from its root entry (kernel `redactReferenceText` precedent).
import { search } from '@deepseek-ai/dsh-plugin-rlm-memory';
import { emitRecallInjectEvent } from "./events.js";
// Re-exported so the loop plugin can consume the CAS write path through this
// package's compiled entry instead of a cross-package src/*.ts specifier,
// which plain Node cannot load from node_modules. `globalHarnessStatePath` /
// `readHarnessStateDetailed` serve the kernel package's skill collector (T2.1).
export { HarnessConflictError, globalHarnessStatePath, harnessStatePath, readHarnessStateDetailed, readHarnessStatesDetailed, writeHarnessStates } from "./harness-file.js";
import { listHarness, showHarnessEntry } from "./harness-cmd.js";
import { createHarnessOverviewCache } from "./prompt-cache.js";
import { renderHarnessOverview } from "./prompt.js";
import { registerStoreProjection } from "./projection.js";
import { runRefineChannelized } from "./refine.js";
export const name = 'plugin-continual-harness';
export const inject = ['systemPrompt', 'commands', 'sessions', 'agents', 'subagents'];
export const Config = z.object({
    // Phase 8: an empty dataDir used to pass the schema and resolve to the cwd.
    dataDir: z.string().min(1),
    maxEntriesPerKind: z.natural().default(6),
    maxCharsPerEntry: z.natural().default(180),
    maxTotalChars: z.natural().default(6000),
    refineProvider: z.string(),
    maxRefinementEvents: z.natural(),
    autoRefine: z.boolean(),
    autoRefineTurnInterval: z.natural(),
    autoRefineCooldownMs: z.natural(),
    recallInject: z.union(['off', 'observe', 'enforce']),
    recallInjectTopN: z.natural().min(1),
    recallInjectBudgetChars: z.natural().min(1),
});
function sessionIdFromAssembleContext(context) {
    // assembleContextFor passes `{ agent, scope: agent, signal }` — at runtime
    // the scope is the Agent object, though its static type is `ScopeKey`.
    const agent = context.scope;
    const id = agent?.session?.id;
    return typeof id === 'string' ? id : undefined;
}
export function apply(ctx, config) {
    const dataDir = config.dataDir ?? path.join(homedir(), '.dsh', 'rlm');
    // item-11: the overview section re-renders per assemble; cache by file
    // (mtime, size) so unchanged harness state is replayed, not re-read+re-sorted.
    const overviewCache = createHarnessOverviewCache({
        globalStatePath: baseDir => globalHarnessStatePath(baseDir),
        localStatePath: (baseDir, sessionId) => harnessStatePath(baseDir, sessionId),
        readMerged: (baseDir, sessionId) => 
        // P0-fix: merged view so global-scope entries (`[global]`-marked)
        // surface in the prompt, not just the per-session local file.
        mergeHarnessStates(readHarnessStateSync(globalHarnessStatePath(baseDir)), readHarnessStateSync(harnessStatePath(baseDir, sessionId))),
        render: state => renderHarnessOverview(state, {
            // exactOptionalPropertyTypes: spread undefined fields away.
            ...(config.maxEntriesPerKind !== undefined ? { maxEntriesPerKind: config.maxEntriesPerKind } : {}),
            ...(config.maxCharsPerEntry !== undefined ? { maxCharsPerEntry: config.maxCharsPerEntry } : {}),
            ...(config.maxTotalChars !== undefined ? { maxTotalChars: config.maxTotalChars } : {}),
        }),
    });
    // Inject harness overview at identity order; base prompt stays untouched.
    // T7.13: the recall-injection suffix rides the same section render — the
    // overview is the time-index channel, the recall is the relevance channel.
    // `observe` (default) records what WOULD be injected without touching the
    // prompt; `enforce` appends the injected section.
    // Phase A authority flip (BUILD.md): harness_state.json (local scope) is a
    // pure projection of the session's store view. Producers (loop now; verify/
    // moa/kernel-relay in this phase) write the store; this listener re-renders
    // the file. Absent store (standalone test assemblies) the file keeps its
    // last content — an honest stale cache, warned once.
    const store = ctx.get('rlm.store');
    if (store) {
        const unregister = registerStoreProjection(store, dataDir);
        ctx.effect(() => unregister, 'rlm-store projection listener');
    }
    else {
        console.warn('[continual-harness] rlm.store service absent — harness projection frozen at its last content (assemble plugin-rlm-store before this plugin)');
    }
    const recallMode = config.recallInject === 'off' || config.recallInject === 'enforce' ? config.recallInject : 'observe';
    const recallTopN = config.recallInjectTopN && config.recallInjectTopN > 0 ? config.recallInjectTopN : 3;
    const recallBudget = config.recallInjectBudgetChars && config.recallInjectBudgetChars > 0 ? config.recallInjectBudgetChars : 2000;
    const memoryDir = path.join(dataDir, 'memory');
    ctx.effect(() => ctx.systemPrompt.section({
        name: 'continual-harness',
        order: -100,
        text: (context) => {
            const sessionId = sessionIdFromAssembleContext(context);
            if (!sessionId)
                return '';
            const base = overviewCache.render(dataDir, sessionId);
            if (recallMode === 'off')
                return base;
            const agent = context.scope;
            const session = agent?.session;
            if (!session || typeof session.deriveMessages !== 'function')
                return base;
            const query = latestUserQuery(session);
            if (!query)
                return base;
            // Phase 8 (review round 6): the search walks every published note
            // with sync reads and no guard — a concurrent delete (ENOENT) or a
            // permission error inside this section callback used to crash EVERY
            // prompt assembly. Recall is advisory: degrade to the base prompt.
            let hits;
            try {
                hits = search(memoryDir, query, recallTopN);
            }
            catch (error) {
                console.warn(`[continual-harness] recall-inject search failed; prompt continues without recall: ${error instanceof Error ? error.message : String(error)}`);
                return base;
            }
            const section = renderRecallSection(query, hits, recallBudget);
            emitRecallInjectEvent(session, {
                mode: recallMode,
                query,
                hitIds: hits.map(hit => hit.relPath),
                injectedChars: section.length,
            });
            // observe: record what WOULD inject; prompt stays unchanged.
            if (recallMode !== 'enforce')
                return base;
            return section.length > 0 ? `${base}\n\n${section}` : base;
        },
    }), 'register continual-harness section');
    // Phase B item 6: /refine is channelized — the extraction subagent only
    // proposes; every landing goes through the judgment channel with the
    // deterministic whitelist criterion (evidence locatable in the transcript).
    // No proposal touches the projection file directly.
    ctx.commands.register({
        name: 'refine',
        description: 'Review the trajectory and land evidence-backed memories through the judgment channel',
        handler: async (invocation) => {
            const store = ctx.get('rlm.store');
            if (!store)
                return { kind: 'error', text: '/refine needs the rlm.store service (mount @deepseek-ai/dsh-plugin-rlm-store)' };
            const sessionId = String(invocation.agent.session.id);
            const outcome = await runRefineChannelized(ctx, store, sessionId, invocation.agent, config.refineProvider ?? 'spawn', invocation.signal);
            return { kind: 'success', text: outcome.text };
        },
    });
    ctx.commands.register({
        name: 'harness',
        description: 'Inspect and manage harness entries: /harness list [kind], /harness show <id>, /harness delete <id>',
        input: { hint: 'list [kind] | show <id> | delete <id>' },
        handler: async (invocation) => {
            const sessionId = String(invocation.agent.session.id);
            const [subcommand, arg] = invocation.rawInput.trim().split(/\s+/, 2);
            switch (subcommand ?? 'list') {
                case 'list':
                    return { kind: 'success', text: listHarness(dataDir, sessionId, arg) };
                case 'show':
                    if (!arg)
                        return { kind: 'error', text: 'Usage: /harness show <id>' };
                    return { kind: 'success', text: showHarnessEntry(dataDir, sessionId, arg) };
                case 'delete':
                    return { kind: 'error', text: '/harness delete is frozen in Phase A: the file is a store projection now — mutate state through the judgment channel (or edit a mailbox note in Phase C), not by deleting projection entries.' };
                default:
                    return { kind: 'error', text: `Unknown /harness subcommand "${subcommand}" (list|show|delete)` };
            }
        },
    });
    // Phase A: the auto-refine scheduler died with /refine's write path
    // (registerAutoRefine lived in refine.ts). The Config fields stay accepted
    // (preset compatibility) but nothing schedules until Phase B channelization.
}
//# sourceMappingURL=index.js.map