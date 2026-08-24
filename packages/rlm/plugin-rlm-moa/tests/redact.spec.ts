/**
 * Unit tests for the `full` privacy-mode redaction. Patterns must mask
 * credential-shaped material and direct PII while leaving code-review-shaped
 * text (versions, IPs, SHAs, timestamps, undelimited digit runs) untouched.
 */
import { describe, expect, it } from 'vitest'
import { MOA_EMAIL_RE, MOA_PHONE_RE, redactReferenceText } from '@deepseek-ai/dsh-plugin-rlm-kernel/src/redact.ts'

describe('redactReferenceText', () => {
  it('masks provider-style secret keys', () => {
    expect(redactReferenceText('use sk-proj-abc123def456789 in env')).toBe('use [redacted key] in env')
  })

  it('masks JWTs but not base64-looking words', () => {
    const out = redactReferenceText('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2Q appended')
    expect(out).toContain('[redacted jwt]')
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(redactReferenceText('eyewitness account')).toBe('eyewitness account')
  })

  it('masks PEM private-key blocks across lines', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK\nabcdef\n-----END RSA PRIVATE KEY-----'
    expect(redactReferenceText(`prefix ${pem} suffix`)).toBe('prefix [redacted private key] suffix')
  })

  it('masks key=value credentials in connection strings without eating URLs', () => {
    const out = redactReferenceText('postgres://u@h/db?password=s3cret&sslmode=require')
    expect(out).toContain('password=[redacted]')
    expect(out).toContain('sslmode=require')
  })

  it('keeps the bearer scheme while masking the token', () => {
    const out = redactReferenceText('Authorization: Bearer abc123._~+/def')
    expect(out).toMatch(/Authorization: bearer \[redacted\]/i)
  })

  it('masks emails and formatted phones; leaves versions, IPs, dates, and bare digit runs alone', () => {
    // Global regexes are stateful under .test(); assert via fresh matches.
    expect('reach me at a.b-team@example.co.uk today'.match(MOA_EMAIL_RE)).toEqual(['a.b-team@example.co.uk'])
    expect('(555) 123-4567'.match(MOA_PHONE_RE)).not.toBeNull()
    expect('555.123.4567'.match(MOA_PHONE_RE)).not.toBeNull()
    expect('5551234567'.match(MOA_PHONE_RE)).toBeNull()
    expect('2026-07-12'.match(MOA_PHONE_RE)).toBeNull()
    expect('10.0.0.1'.match(MOA_PHONE_RE)).toBeNull()

    const text = 'v2.11.0 sha 3f9a2b ip 10.0.0.1 date 2026-07-12 id 5551234567 call 555-123-4567 mail bob@corp.io'
    const out = redactReferenceText(text)
    expect(out).toContain('v2.11.0')
    expect(out).toContain('10.0.0.1')
    expect(out).toContain('2026-07-12')
    expect(out).toContain('5551234567')
    expect(out).toContain('[redacted phone]')
    expect(out).toContain('[redacted email]')
    expect(out).not.toContain('bob@corp.io')
  })
})
