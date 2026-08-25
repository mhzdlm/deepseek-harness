import { describe, expect, it } from 'vitest'
import { isCleanComplete, parseAuditHeader } from '../src/parse.ts'

describe('parseAuditHeader', () => {
  it('parses the ordered three-line header', () => {
    const report = [
      'Status: complete',
      'Integrity: clean',
      'Contract audit: aligned',
      '',
      'Verified facts: file exists.',
    ].join('\n')
    expect(parseAuditHeader(report)).toEqual({
      status: 'complete',
      integrity: 'clean',
      contract: 'aligned',
    })
  })

  it('accepts CRLF and surrounding whitespace on the verdict lines', () => {
    const report = 'Status: incomplete\r\n  Integrity: suspect  \r\nContract audit: needs_revision\r\nbody'
    expect(parseAuditHeader(report)).toEqual({
      status: 'incomplete',
      integrity: 'suspect',
      contract: 'needs_revision',
    })
  })

  it('is case-insensitive on labels and values', () => {
    expect(parseAuditHeader('status: BLOCKED\nintegrity: Clean\ncontract audit: Aligned')).toEqual({
      status: 'blocked',
      integrity: 'clean',
      contract: 'aligned',
    })
  })

  it('skips empty lines but keeps the first three non-empty lines authoritative', () => {
    expect(parseAuditHeader('\n\nStatus: complete\n\nIntegrity: clean\n\nContract audit: aligned\n')).toEqual({
      status: 'complete',
      integrity: 'clean',
      contract: 'aligned',
    })
  })

  it('rejects when the order differs', () => {
    expect(
      parseAuditHeader('Integrity: clean\nStatus: complete\nContract audit: aligned'),
    ).toBeNull()
  })

  it('rejects values outside the enums', () => {
    expect(parseAuditHeader('Status: fine\nIntegrity: clean\nContract audit: aligned')).toBeNull()
    expect(parseAuditHeader('Status: complete\nIntegrity: perfect\nContract audit: aligned')).toBeNull()
    expect(parseAuditHeader('Status: complete\nIntegrity: clean\nContract audit: yes')).toBeNull()
  })

  it('rejects prose before the header', () => {
    expect(
      parseAuditHeader('Here is my audit.\nStatus: complete\nIntegrity: clean\nContract audit: aligned'),
    ).toBeNull()
  })

  it('rejects short reports', () => {
    expect(parseAuditHeader('Status: complete')).toBeNull()
    expect(parseAuditHeader('')).toBeNull()
  })
})

describe('isCleanComplete', () => {
  it('clears only the full clean triple', () => {
    expect(isCleanComplete({ status: 'complete', integrity: 'clean', contract: 'aligned' })).toBe(true)
    expect(isCleanComplete({ status: 'incomplete', integrity: 'clean', contract: 'aligned' })).toBe(false)
    expect(isCleanComplete({ status: 'complete', integrity: 'suspect', contract: 'aligned' })).toBe(false)
    expect(isCleanComplete({ status: 'complete', integrity: 'clean', contract: 'unknown' })).toBe(false)
  })
})
