/**
 * Phase B keyword/BM25-ish recall over `published/` notes (REME.md §5.2 D8,
 * §10 Phase B acceptance). The index is a DERIVABLE artifact: it is rebuilt
 * in-memory from the `published/` files on every call, so it can never drift
 * from the notes and re-running after a delete is byte-equivalent (the
 * "delete-and-rerun equivalence" acceptance). No `index/keyword.json` is
 * persisted — incremental/maintained indexing is a Phase C/D extension point.
 *
 * Tokenization handles mixed Chinese/English: ASCII words (lowercased, length
 * ≥ 2) plus CJK character bigrams, so a Chinese query matches Chinese notes and
 * an English query matches English notes. Scoring is tf × idf over the
 * title+body term frequency; results sort by score desc, tie-break by recency
 * (`updated_at` desc), deterministic and stable.
 *
 * Borrow: the retrieval channel + "search only published" gate mirrors ReMe
 * `reme_search` + the publish-gate semantics of REME.md §5.2 D8; the index
 * rebuildability mirrors REME.md §4 D3 ("Memory as File, File as Memory").
 *
 * @module @deepseek-ai/dsh-plugin-rlm-memory/search
 */
import { readNote, type Note } from './storage.ts';
import { type EmbeddingService } from './embedding.ts';
/** One note's derived recall fields, carried alongside its source path. */
export interface IndexedNote {
    /** Relative note path under `memoryDir` (e.g. `published/wiki/x.md`). */
    relPath: string;
    /** The parsed note (frontmatter + body). */
    note: Note;
    /** Title used for display: the first `#`-headed line, else the note `source`. */
    title: string;
    /** Pre-tokenized term multiset over title + body (term -> count). */
    terms: Map<string, number>;
    /** `updated_at` ISO, kept for recency tie-break. */
    updatedAt: string;
}
/** One ranked search hit returned to the model. */
export interface SearchHit {
    /** Relative note path under `memoryDir`. */
    relPath: string;
    /** Display title. */
    title: string;
    /** Note kind (procedure|personal|wiki). */
    kind: string;
    /** Score (sum of tf × idf over matched query terms). */
    score: number;
    /** Full note body. */
    body: string;
}
/**
 * Tokenize mixed CN/EN text into a term multiset: ASCII words (lowercased,
 * length ≥ 2) and CJK character bigrams. Bigrams let a partial Chinese query
 * match a note that shares the adjacent characters. Returns a Map of term ->
 * frequency within this single note body; callers aggregate across notes.
 * @param text - the title + body text to tokenize.
 * @returns a map from term to its count in `text`.
 */
export declare function tokenize(text: string): Map<string, number>;
/**
 * Build the in-memory inverted index from `published/` only. Reads every
 * published note, tokenizes title+body, and produces the per-note term map plus
 * a `term -> Set<noteId>` inverted index (noteId is the relative path, unique).
 * Drafts/archive are excluded by {@link listPublished} (REME.md §5.2 D8).
 * @param memoryDir - resolved memory root.
 * @returns the indexed notes and the inverted term -> note-id map.
 */
export declare function buildIndex(memoryDir: string): {
    notes: IndexedNote[];
    inverted: Map<string, Set<string>>;
};
/**
 * Search `published/` notes for `query`, returning up to `limit` ranked full-text
 * hits. An optional `kind` filter restricts the bucket. Scoring sums, over each
 * matched query term, `tf(term, note) × idf(term)` where idf = log(N / n_with_term)
 * (N = number of notes, n_with_term = notes containing the term), with a
 * divide-by-zero guard (a term in every note yields idf 0). Results sort by score
 * desc, then `updated_at` desc (recency tie-break). Deterministic and stable.
 * @param memoryDir - resolved memory root.
 * @param query - the user/recall query string.
 * @param limit - maximum number of hits to return.
 * @param kind - optional bucket filter (`procedure`|`personal`|`wiki`).
 * @returns ranked hits (full text), empty array when nothing matches.
 */
export declare function search(memoryDir: string, query: string, limit: number, kind?: string): SearchHit[];
/**
 * Hybrid recall (Phase E, REME.md §12.1): blend lexical BM25 with cosine similarity over
 * each note's cached embedding. Only used when an `EmbeddingService` is configured
 * (`embeddingsProvider !== 'off'`); otherwise callers use {@link search} (lexical only).
 * A note with no cached embedding scores 0 on the vector axis, so lexical recall still
 * applies. Async because embedding is a network call. Returns the same {@link SearchHit}
 * shape as {@link search} so the `memory_search` tool renders unchanged.
 *
 * Borrow: vector + lexical fusion mirrors the hybrid retrieval the Continual Harness
 * paper expects for retrieval quality; here it is a dsh-native seam stand-in.
 *
 * @param memoryDir - resolved memory root.
 * @param query - the recall query.
 * @param limit - max hits.
 * @param kind - optional bucket filter.
 * @param embeddingService - the configured embedding provider.
 * @returns ranked hits.
 */
export declare function hybridSearch(memoryDir: string, query: string, limit: number, kind: string | undefined, embeddingService: EmbeddingService): Promise<SearchHit[]>;
/** Re-export for tool/callers that need raw note reads. */
export { readNote };
//# sourceMappingURL=search.d.ts.map