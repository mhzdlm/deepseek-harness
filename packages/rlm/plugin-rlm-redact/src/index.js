/**
 * Package entry for `@deepseek-ai/dsh-plugin-rlm-redact`. The redactor itself
 * lives in `./redact.ts` and stays importable directly (the package "exports"
 * map points at it); this entry exists so the package root matches the
 * workspace build contract (`main: lib/types/index.js`, root tsdown entry
 * glob) rather than for new surface.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-redact
 */
export * from "./redact.js";
//# sourceMappingURL=index.js.map