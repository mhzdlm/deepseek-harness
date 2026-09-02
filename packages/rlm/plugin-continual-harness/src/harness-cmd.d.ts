/**
 * `/harness` management command (item-5): list / show harness entries without
 * writing a proposal subagent. Mutations are frozen in Phase A — the file is
 * a store projection now (see ./projection.ts).
 * @module @deepseek-ai/dsh-plugin-continual-harness
 */
/**
 * `/harness list [kind]`: all entries, newest first, full ids, scope markers.
 * @param baseDir - the workspace root used to locate harness state files.
 * @param sessionId - the session whose scoped entries are merged in.
 * @param kind - optional kind filter (`prompt`/`memory`/`skill`/`subagent`); lists all when omitted.
 * @returns a human-readable listing of harness entries, or an error string for an unknown kind.
 */
export declare function listHarness(baseDir: string, sessionId: string, kind?: string): string;
/**
 * `/harness show <id>`: full detail for one entry.
 * @param baseDir - the workspace root used to locate harness state files.
 * @param sessionId - the session whose scoped entries are merged in.
 * @param selector - exact id or unique id prefix of the entry to display.
 * @returns a formatted detail block for the resolved entry, or an error string.
 */
export declare function showHarnessEntry(baseDir: string, sessionId: string, selector: string): string;
//# sourceMappingURL=harness-cmd.d.ts.map