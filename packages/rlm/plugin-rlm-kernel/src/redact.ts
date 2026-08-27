/**
 * Conservative reference-text redaction shared by the RLM judgment tools
 * (`moa` panel advisor text; `verify` candidate text). Credential-shaped
 * material and direct PII are masked before text crosses into another model
 * call or a durable surface.
 *
 * Pattern safety follows the same reasoning as upstream advisory panels:
 * advisor text is frequently code-review-shaped (line numbers, SHAs, IPs,
 * versions), so patterns require strong distinguishing markers and never
 * match bare digit runs. This module is intentionally self-contained — the
 * harness has no central redactor yet; revisit when one lands.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-kernel/redact
 */

/** Provider-style secret keys: sk-…, sk-proj-…, and similar prefixed forms. */
const SECRET_KEY_RE = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g

/** GitHub token families: ghp_ / gho_ / gpu_ / ghs_ / ghr_. */
const GITHUB_TOKEN_RE = /\bgh[posr]_[A-Za-z0-9]{16,}\b/g

/** JWT triple segments. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g

/** PEM private-key blocks, including multi-line bodies. */
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g

/** Credentials inside URLs / connection strings: password=…, pwd=…, api_key=…, token=… */
const KV_SECRET_RE = /\b(password|passwd|pwd|api[_-]?key|access[_-]?token|token|secret)=([^&\s"'<>]+)/gi

/** Bearer/Authorization header values (scheme preserved). */
const BEARER_RE = /\b(authorization["']?\s*[:=]\s*["']?)bearer\s+\S+/gi

/**
 * Email addresses. Advisory text rarely quotes emails as data, so a plain
 * pattern is safe here (upstream uses the identical shape).
 */
export const MOA_EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

/**
 * Formatted phone numbers requiring explicit delimiters — parenthesized area
 * codes or `-`/`.` separators between groups. Undelimited digit runs, dates,
 * times, hex ids, and dotted quads never match.
 */
export const MOA_PHONE_RE =
  /(?<![\w.+-])(?:\+?1[ .-])?(?:\(\d{3}\)[ .-]?|\d{3}[.-])\d{3}[.-]\d{4}(?![\w-])/g

/**
 * Redact credential-shaped material plus email/formatted-phone PII from one
 * advisor text. Non-string input passes through unchanged.
 * @param text - advisor answer (or any surface destined for the aggregator).
 * @returns the input text with credential-shaped material and email/phone PII masked.
 */
export function redactReferenceText(text: string): string {
  let out = text
  out = out.replace(PRIVATE_KEY_RE, '[redacted private key]')
  out = out.replace(SECRET_KEY_RE, '[redacted key]')
  out = out.replace(GITHUB_TOKEN_RE, '[redacted token]')
  out = out.replace(JWT_RE, '[redacted jwt]')
  out = out.replace(BEARER_RE, '$1bearer [redacted]')
  out = out.replace(KV_SECRET_RE, (_m, key: string) => `${key}=[redacted]`)
  out = out.replace(MOA_EMAIL_RE, '[redacted email]')
  out = out.replace(MOA_PHONE_RE, '[redacted phone]')
  return out
}
