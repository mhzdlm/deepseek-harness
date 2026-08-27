#!/usr/bin/env node
// Mechanical fixer for non-conforming Agent Notes (implemented/ lifecycle).
//
// Usage:
//   node scripts/fix-agent-note-format.mjs [--check] <file.md> [<file2.md> ...]
//   --check   report only, do not rewrite
//
// Operates on English .md only. .zh.md counterparts are translated by hand
// because the machine-checked header tokens must stay verbatim in English.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const paths = args.filter((a) => a !== '--check')

const BANNED = ['## Proposal', '## Plan', '## Migration plan', '## Acceptance criteria']

function collectFiles(input) {
  const abs = resolve(input)
  if (statSync(abs).isDirectory()) {
    return readdirSync(abs)
      .filter((f) => f.endsWith('.md') && !f.endsWith('.zh.md'))
      .map((f) => join(abs, f))
  }
  return [abs]
}

function fixLines(lines) {
  const out = [...lines]
  if (out[0] && out[0].startsWith('# ') && !out[0].startsWith('# Agent Note: ')) {
    out[0] = out[0].replace(/^# /, '# Agent Note: ')
  }
  const needsHeader = !out[0].startsWith('# Agent Note: ') || out[2] !== 'Status: implemented'
  if (needsHeader) {
    const title = out[0]
    const rest = out.slice(1).filter((l) => !/^Status:\s/.test(l))
    while (rest.length && rest[0] === '') rest.shift()
    out.length = 0
    out.push(title, '', 'Status: implemented', '', ...rest)
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i].startsWith('## ') && out[i] !== '## Problem') {
      out[i] = '## Problem'
      break
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i] === '## Given up') out[i] = '## Alternatives considered'
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i] === '## Required verification') out[i] = '## Verification'
  }
  if (!out.includes('## Consequences')) {
    let anchor = out.indexOf('## Verification')
    if (anchor === -1) anchor = out.indexOf('## Decision')
    if (anchor === -1) anchor = out.length
    out.splice(
      anchor,
      0,
      '## Consequences',
      '',
      '<!-- TODO: one or two bullets on what the trade-off bought and cost -->',
      '',
    )
  }
  const banned = out.filter((l) => BANNED.includes(l))
  return { out, banned }
}

function isConforming(lines) {
  if (!lines[0] || !lines[0].startsWith('# Agent Note: ')) return false
  if (lines[2] !== 'Status: implemented') return false
  const h2 = new Set(lines.filter((l) => l.startsWith('## ')))
  if (!h2.has('## Problem')) return false
  return h2.has('## Decision') && h2.has('## Consequences') && h2.has('## Alternatives considered')
}

let changed = 0
let clean = 0
for (const p of paths) {
  if (!existsSync(p)) {
    console.error(`skip (missing): ${p}`)
    continue
  }
  const files = collectFiles(p)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    if (isConforming(lines)) {
      console.log(`conform: ${file}`)
      clean++
      continue
    }
    const { out, banned } = fixLines(lines)
    if (banned.length) {
      console.warn(`warn (banned headers, fix by hand): ${file} -> ${banned.join(', ')}`)
    }
    if (checkOnly) {
      console.log(`would fix: ${file}`)
      continue
    }
    writeFileSync(file, out.join('\n'), 'utf8')
    console.log(`fixed: ${file}`)
    changed++
  }
}
console.log(
  `done: ${changed} fixed, ${clean} already conforming${checkOnly ? ' (check-only)' : ''}`,
)
