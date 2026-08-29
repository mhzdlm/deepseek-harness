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

import { listPublished, parseNote, readNote, type Note } from './storage.ts'

/** One note's derived recall fields, carried alongside its source path. */
export interface IndexedNote {
  /** Relative note path under `memoryDir` (e.g. `published/wiki/x.md`). */
  relPath: string
  /** The parsed note (frontmatter + body). */
  note: Note
  /** Title used for display: the first `#`-headed line, else the note `source`. */
  title: string
  /** Pre-tokenized term multiset over title + body (term -> count). */
  terms: Map<string, number>
  /** `updated_at` ISO, kept for recency tie-break. */
  updatedAt: string
}

/** One ranked search hit returned to the model. */
export interface SearchHit {
  /** Relative note path under `memoryDir`. */
  relPath: string
  /** Display title. */
  title: string
  /** Note kind (procedure|personal|wiki). */
  kind: string
  /** Score (sum of tf × idf over matched query terms). */
  score: number
  /** Full note body. */
  body: string
}

/** A CJK codepoint range check (covers common Han, Hiragana, Katakana, Hangul). */
function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (
    (code >= 0x4e00 && code <= 0x9fff) // CJK Unified Ideographs
    || (code >= 0x3040 && code <= 0x30ff) // Hiragana + Katakana
    || (code >= 0xac00 && code <= 0xd7a3) // Hangul Syllables
  )
}

/**
 * Tokenize mixed CN/EN text into a term multiset: ASCII words (lowercased,
 * length ≥ 2) and CJK character bigrams. Bigrams let a partial Chinese query
 * match a note that shares the adjacent characters. Returns a Map of term ->
 * frequency within this single note body; callers aggregate across notes.
 * @param text - the title + body text to tokenize.
 * @returns a map from term to its count in `text`.
 */
export function tokenize(text: string): Map<string, number> {
  const terms = new Map<string, number>()
  const lower = text.toLowerCase()

  // ASCII word runs: letters/digits, length >= 2 (REME.md §5.2 mixed-language).
  const asciiWords = lower.match(/[a-z0-9]{2,}/g) ?? []
  for (const word of asciiWords) {
    terms.set(word, (terms.get(word) ?? 0) + 1)
  }

  // CJK character bigrams: slide a 2-char window over each CJK run.
  const chars = Array.from(lower)
  let prevCjk: string | null = null
  for (const ch of chars) {
    if (isCjk(ch)) {
      if (prevCjk !== null) {
        const bigram = `${prevCjk}${ch}`
        terms.set(bigram, (terms.get(bigram) ?? 0) + 1)
      }
      prevCjk = ch
    } else {
      prevCjk = null
    }
  }

  return terms
}

/** Extract a display title from a note body's first `#` heading, else its source. */
function noteTitle(note: Note): string {
  const firstLine = (note.body.split('\n')[0] ?? '').replace(/^#\s*/, '').trim()
  return firstLine.length > 0 ? firstLine : note.frontmatter.source
}

/**
 * Build the in-memory inverted index from `published/` only. Reads every
 * published note, tokenizes title+body, and produces the per-note term map plus
 * a `term -> Set<noteId>` inverted index (noteId is the relative path, unique).
 * Drafts/archive are excluded by {@link listPublished} (REME.md §5.2 D8).
 * @param memoryDir - resolved memory root.
 * @returns the indexed notes and the inverted term -> note-id map.
 */
export function buildIndex(memoryDir: string): {
  notes: IndexedNote[]
  inverted: Map<string, Set<string>>
} {
  const notes: IndexedNote[] = []
  const inverted = new Map<string, Set<string>>()
  for (const path of listPublished(memoryDir)) {
    const note = parseNote(path)
    if (!note) continue
    const relPath = path.startsWith(memoryDir) ? path.slice(memoryDir.length).replace(/^[\\/]/, '') : path
    const title = noteTitle(note)
    const terms = tokenize(`${title}\n${note.body}`)
    const indexed: IndexedNote = {
      relPath,
      note,
      title,
      terms,
      updatedAt: note.frontmatter.updated_at,
    }
    notes.push(indexed)
    for (const term of terms.keys()) {
      let set = inverted.get(term)
      if (!set) {
        set = new Set<string>()
        inverted.set(term, set)
      }
      set.add(relPath)
    }
  }
  return { notes, inverted }
}

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
export function search(memoryDir: string, query: string, limit: number, kind?: string): SearchHit[] {
  const { notes, inverted } = buildIndex(memoryDir)
  if (notes.length === 0) return []

  const queryTerms = tokenize(query)
  if (queryTerms.size === 0) return []

  const N = notes.length
  const scored: Array<{ note: IndexedNote; score: number }> = []
  for (const note of notes) {
    if (kind !== undefined && note.note.frontmatter.kind !== kind) continue
    let score = 0
    for (const term of queryTerms.keys()) {
      const tf = note.terms.get(term) ?? 0
      if (tf === 0) continue
      const docsWithTerm = inverted.get(term)?.size ?? 0
      // BM25-style smoothed idf (REME.md §5.2 "BM25式倒排"): idf = log(1 + (N -
      // n + 0.5)/(n + 0.5)). The +0.5 in the denominator is the divide-by-zero
      // guard (n >= 1 for any term we iterate), and smoothing keeps recall
      // non-degenerate in a single-note corpus, where the classic log(N/n)
      // collapses to 0 for every term (a term present in the only note scores
      // 0 under log(1/1)). A term present in fewer than all notes still gets a
      // positive weight, so a matching note is always returned and ranked above
      // a note matching fewer terms.
      const idf = docsWithTerm > 0 ? Math.log(1 + (N - docsWithTerm + 0.5) / (docsWithTerm + 0.5)) : 0
      score += tf * idf
    }
    if (score > 0) scored.push({ note, score })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Recency tie-break: newer `updated_at` ranks first. String ISO compares
    // lexicographically in chronological order, so descending string order works.
    return a.note.updatedAt < b.note.updatedAt ? 1 : a.note.updatedAt > b.note.updatedAt ? -1 : 0
  })

  return scored.slice(0, Math.max(0, limit)).map(({ note, score }) => ({
    relPath: note.relPath,
    title: note.title,
    kind: note.note.frontmatter.kind,
    score,
    body: note.note.body,
  }))
}

/** Re-export for tool/callers that need raw note reads. */
export { readNote }
