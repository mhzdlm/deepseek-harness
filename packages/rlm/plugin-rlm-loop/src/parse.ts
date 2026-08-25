/**
 * Deterministic parser for the Loop Engineering auditor report header. The
 * audit protocol requires the first three non-empty lines to carry exactly one
 * verdict per line, in order:
 *
 *   `Status: complete|incomplete|blocked`
 *   `Integrity: clean|suspect|violation`
 *   `Contract audit: aligned|unknown|needs_revision|invalid`
 *
 * Only this header is machine-acted on; the prose body stays evidence for the
 * manager. A missing or malformed header is a parse failure, never a guess.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-loop/parse
 */

/** Verdict on whether the audited subtask actually reached its target state. */
export type AuditStatus = 'complete' | 'incomplete' | 'blocked'
/** Verdict on evidence authenticity: fabricated or untrustworthy artifacts fail here. */
export type AuditIntegrity = 'clean' | 'suspect' | 'violation'
/** Verdict on whether the executed subtask still matches the stable task contract. */
export type AuditContract = 'aligned' | 'unknown' | 'needs_revision' | 'invalid'

export interface AuditHeader {
  status: AuditStatus
  integrity: AuditIntegrity
  contract: AuditContract
}

const STATUS_LINE = /^status:\s*(complete|incomplete|blocked)$/i
const INTEGRITY_LINE = /^integrity:\s*(clean|suspect|violation)$/i
const CONTRACT_LINE = /^contract audit:\s*(aligned|unknown|needs_revision|invalid)$/i

/**
 * Parse the three-line audit header from a report.
 * @param report - the full auditor output; CRLF or LF line endings both work.
 * @returns the parsed header, or `null` when the first three non-empty lines
 * are not exactly the ordered `Status` / `Integrity` / `Contract audit` triple.
 */
export function parseAuditHeader(report: string): AuditHeader | null {
  const lines = String(report ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
  if (lines.length < 3) return null
  const status = STATUS_LINE.exec(lines[0] ?? '')
  const integrity = INTEGRITY_LINE.exec(lines[1] ?? '')
  const contract = CONTRACT_LINE.exec(lines[2] ?? '')
  if (!status || !integrity || !contract) return null
  return {
    status: (status[1] ?? '').toLowerCase() as AuditStatus,
    integrity: (integrity[1] ?? '').toLowerCase() as AuditIntegrity,
    contract: (contract[1] ?? '').toLowerCase() as AuditContract,
  }
}

/**
 * Whether an audit header clears the trust gate: only a complete, clean,
 * contract-aligned round may become verified progress.
 */
export function isCleanComplete(header: AuditHeader): boolean {
  return header.status === 'complete'
    && header.integrity === 'clean'
    && header.contract === 'aligned'
}
