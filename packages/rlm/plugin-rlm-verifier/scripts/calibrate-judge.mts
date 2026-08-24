/**
 * Live calibration probe for the TypeScript judge contract: builds one
 * pairwise prompt through buildJudgePrompt, sends it to api.deepseek.com
 * with chosen-token logprobs, then runs findTagLogprobs/extractScore on the
 * captured stream and reports whether the score-tag positions were located.
 *
 * Usage: node --import tsx scripts/calibrate-judge.mts [model]
 * Reads DEEPSEEK_API_KEY from the repo-root .env or the environment.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildJudgePrompt, extractScore } from '../src/scoring.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
let key = process.env.DEEPSEEK_API_KEY
try {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
    const m = /^DEEPSEEK_API_KEY=(.+)$/.exec(line.trim())
    if (m) key = m[1]
  }
} catch {}
if (!key) {
  console.error('calibrate: DEEPSEEK_API_KEY not set (.env or environment)')
  process.exit(1)
}

const model = process.argv[2] ?? 'deepseek-v4-flash'
const prompt = buildJudgePrompt({
  problem: 'Write the number 7 to answer.txt.',
  traceA: 'Ran: echo 7 > answer.txt\nVerified: cat answer.txt -> 7',
  traceB: 'Ran: echo 8 > answer.txt\nNo verification performed.',
  criterion: { id: 'correctness', name: 'Correctness', description: 'Did the agent produce the numerically correct file content?' },
  groundTruthNote: 'The correct content is exactly `7`.',
})

interface PositionEntry {
  token: string
  logprob: number
  top_logprobs?: Array<{ token: string; logprob: number }>
}
interface WireResponse {
  choices?: Array<{
    message?: { content?: string | null }
    logprobs?: { content?: PositionEntry[] } | null
    finish_reason?: string
  }>
}

const res = await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 4096,
    temperature: 1.0,
    logprobs: true,
    top_logprobs: 20,
  }),
})
if (!res.ok) {
  console.error(`HTTP ${res.status}:`, (await res.text()).slice(0, 400))
  process.exit(1)
}
const wire = (await res.json()) as WireResponse
const choice = wire.choices?.[0]
const text = choice?.message?.content ?? ''
const positions = choice?.logprobs?.content ?? []

const tokens = positions.map(p => p.token)
const alternatives = positions.map(p => {
  const alts = (p.top_logprobs ?? []).map(alt => [alt.token, alt.logprob] as const)
  return alts.length > 0 ? alts : [[p.token, p.logprob] as const]
})

const tail = text.slice(-260)
console.log(`model=${model} positions=${positions.length} finish=${choice?.finish_reason}`)
console.log(`text tail:\n…${tail}`)
for (const tag of ['<score_A>', '<score_B>']) {
  const score = extractScore(text, tokens, alternatives, tag)
  const present = text.includes(tag)
  console.log(`${tag}: present_in_text=${present} extracted_score=${score.toFixed(4)}`)
}
