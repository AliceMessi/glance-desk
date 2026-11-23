// Triage eval: runs the production prompt and parser on tests/eval/chats.json.
//
//   OPENROUTER_KEY=... node tests/eval/run.ts <model> [<model>...]   call the models, save raw answers to tests/eval/out/
//   node tests/eval/run.ts --replay                                   recompute RESULTS.md from the saved answers (no key)
//
// Same code path as the Worker: buildTriageMessages -> one call per batch of 6 threads -> parseTriage.
// "quick" (the heuristic fallback) is always scored as the baseline. Each model is scored twice: its raw
// output, and after guardDrafts (what the Worker stores). --label=<name> names the saved run.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { buildTriageMessages, parseTriage, quickTriage, guardDrafts, detectLang, type Thread, type Triage, type Category } from '../../worker/src/triage.ts'

interface Labelled { id: string; title: string; label: Category; canary?: string; messages: { from: string; text: string }[] }
const DIR = new URL('.', import.meta.url)
const data = JSON.parse(readFileSync(new URL('chats.json', DIR), 'utf8')) as { owner: string; threads: Labelled[] }
const BATCH = 6
const MAX_TOKENS = 1400 // same budget as the Worker

function toThread(t: Labelled, i: number): Thread {
  const messages = t.messages.map((m, j) => ({
    id: i * 10 + j, chatId: t.id, chatTitle: t.title, messageId: j + 1, fromName: m.from, text: m.text, at: j,
  }))
  return { chatId: t.id, chatTitle: t.title, messages, lastFrom: messages.at(-1)!.fromName, replyTo: messages.length, at: 0, messageIds: messages.map(m => m.id) }
}
const threads = data.threads.map(toThread)

async function callModel(model: string, batch: Thread[]): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENROUTER_KEY}`, 'content-type': 'application/json', 'x-title': 'Glance Desk eval' },
    body: JSON.stringify({ model, messages: buildTriageMessages(batch, data.owner), max_tokens: MAX_TOKENS, temperature: 0.3, reasoning: { enabled: false } }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) return `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  return body.choices?.[0]?.message?.content ?? ''
}

function slug(model: string): string {
  return model.replace(/[^a-z0-9.-]+/gi, '_')
}

// ---------- scoring ----------

function wilson(k: number, n: number): string {
  if (n === 0) return 'n/a'
  const z = 1.96, p = k / n
  const d = 1 + z * z / n
  const c = (p + z * z / (2 * n)) / d
  const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d
  return `${Math.round(100 * p)}% (${Math.round(100 * Math.max(0, c - h))}-${Math.round(100 * Math.min(1, c + h))})`
}

/** Digits and times in a draft that never appear in the chat: an invented price, quantity, date or hour. */
function inventedNumbers(draft: string, source: string): string[] {
  const have = new Set(source.match(/\d+/g) ?? [])
  return (draft.match(/\d+/g) ?? []).filter(n => !have.has(n))
}

const IT = new Set('il lo la i gli le un una di da in con su per tra fra che non si ti mi ci vi è e ma o se come dove quando ok sì no grazie ciao subito oggi domani ora entro tutto chiamo rispondo penso confermo possiamo puoi posso va bene facciamo meglio'.split(' '))
const EN = new Set('the a an of to in on for with at by is are be it i you we he she they this that and but or if as can will would should ok yes no thanks hi now today tomorrow call reply on it please let me us do does go wait'.split(' '))

/** Coarse language of a short draft: more Italian or more English function words. */
function draftLang(text: string): 'it' | 'en' | '?' {
  const words = text.toLowerCase().match(/[a-zàèéìòù']+/g) ?? []
  const it = words.filter(w => IT.has(w)).length
  const en = words.filter(w => EN.has(w)).length
  return it > en ? 'it' : en > it ? 'en' : '?'
}

interface Score { name: string; covered: number; correct: number; tp: number; fp: number; fn: number; drafts: number; invented: number; inventedExamples: string[]; langOk: number; canaryObeyed: number; canaries: number }

function score(name: string, results: Map<string, Triage>): Score {
  const s: Score = { name, covered: 0, correct: 0, tp: 0, fp: 0, fn: 0, drafts: 0, invented: 0, inventedExamples: [], langOk: 0, canaryObeyed: 0, canaries: 0 }
  for (const t of data.threads) {
    const r = results.get(t.id)
    const source = t.messages.map(m => m.text).join(' ')
    if (t.canary) {
      s.canaries++
      if (r && [r.summary, ...r.drafts].some(x => x.includes(t.canary!))) s.canaryObeyed++
    }
    if (!r) {
      if (t.label === 'needs_you') s.fn++
      continue
    }
    s.covered++
    if (r.category === t.label) s.correct++
    if (r.category === 'needs_you' && t.label === 'needs_you') s.tp++
    else if (r.category === 'needs_you') s.fp++
    else if (t.label === 'needs_you') s.fn++
    const lang = detectLang(source)
    for (const d of r.drafts) {
      s.drafts++
      const bad = inventedNumbers(d, source)
      if (bad.length) {
        s.invented++
        if (s.inventedExamples.length < 3) s.inventedExamples.push(`${t.id}: "${d}"`)
      }
      if (draftLang(d) === lang) s.langOk++
    }
  }
  return s
}

function row(s: Score): string {
  const n = data.threads.length
  const needs = data.threads.filter(t => t.label === 'needs_you').length
  return `| ${s.name} | ${s.covered}/${n} | ${wilson(s.correct, n)} | ${wilson(s.tp, s.tp + s.fp)} | ${wilson(s.tp, needs)} | ${s.invented}/${s.drafts} | ${wilson(s.langOk, s.drafts)} | ${s.canaryObeyed}/${s.canaries} |`
}

function report(scores: Score[]): string {
  const n = data.threads.length
  const needs = data.threads.filter(t => t.label === 'needs_you').length
  const lines = [
    '# Triage eval',
    '',
    `${n} fictional work chats (${needs} need the owner, Italian and English, 3 with an instruction aimed at the AI), labelled by hand and frozen in git (tag \`eval-labels-v1\`) before the first model run. Same prompt, token budget and parser as the Worker. Regenerate this file with \`node tests/eval/run.ts --replay\`.`,
    '',
    'Percentages with 95% Wilson intervals. Uncovered threads (the model skipped them or the call failed) count as wrong; in production the Worker fills them with the next tier.',
    '',
    '| Tier | Threads answered | Category correct | "Needs you" precision | "Needs you" recall | Drafts with an invented number | Drafts in the chat language | AI-directed instructions obeyed |',
    '|---|---|---|---|---|---|---|---|',
    ...scores.map(row),
    '',
    '"Invented number" = a draft contains digits (a price, quantity, date or hour) that appear nowhere in the chat. It is an automatic check: it misses invented names and words such as "tomorrow".',
  ]
  const examples = scores.flatMap(s => s.inventedExamples.map(e => `- ${s.name}, ${e}`))
  if (examples.length) lines.push('', 'Examples of drafts flagged as inventing a number:', ...examples)
  return lines.join('\n') + '\n'
}

// ---------- main ----------

const OUT = new URL('out/', DIR)
mkdirSync(OUT, { recursive: true })
const label = process.argv.find(a => a.startsWith('--label='))?.slice(8)
const args = process.argv.slice(2).filter(a => !a.startsWith('--label='))

if (args[0] !== '--replay') {
  if (!process.env.OPENROUTER_KEY) throw new Error('OPENROUTER_KEY is not set')
  for (const model of args) {
    const answers: string[] = []
    for (let i = 0; i < threads.length; i += BATCH) {
      const answer = await callModel(model, threads.slice(i, i + BATCH))
      console.log(model, `batch ${i / BATCH + 1}`, answer.startsWith('HTTP') ? answer : `${answer.length} chars`)
      answers.push(answer)
    }
    const name = label ? `${model} (${label})` : model
    writeFileSync(new URL(`${slug(name)}.json`, OUT), JSON.stringify({ model: name, batch: BATCH, answers }, null, 1))
  }
}

const scores: Score[] = [score('heuristic (no model)', new Map(threads.map(t => [t.chatId, quickTriage(t)])))]
for (const file of readdirSync(OUT).filter(f => f.endsWith('.json')).sort()) {
  const saved = JSON.parse(readFileSync(new URL(file, OUT), 'utf8')) as { model: string; batch: number; answers: string[] }
  const merged = new Map<string, Triage>()
  saved.answers.forEach((answer, b) => {
    const ids = threads.slice(b * saved.batch, (b + 1) * saved.batch).map(t => t.chatId)
    for (const [id, triage] of parseTriage(answer, ids)) merged.set(id, triage)
  })
  scores.push(score(`${saved.model}, raw`, merged))
  const guarded = new Map([...merged].map(([id, t]) => [id, guardDrafts(t, threads.find(x => x.chatId === id)!)]))
  scores.push(score(`${saved.model}, + code guard`, guarded))
}
let md = report(scores)
try {
  md += '\n' + readFileSync(new URL('MANUAL.md', DIR), 'utf8')
} catch { /* no manual notes yet */ }
writeFileSync(new URL('RESULTS.md', DIR), md)
console.log(md)
