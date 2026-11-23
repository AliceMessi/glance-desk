// End-to-end check against a running Worker (default: wrangler dev on 127.0.0.1:8787).
// Usage: node tests/e2e.mjs [baseUrl]   (needs TG_WEBHOOK_SECRET=local-test-secret in worker/.dev.vars)
// Without OPENROUTER_KEY the Worker uses the heuristic triage, which this script expects.

import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787'
const SECRET = 'local-test-secret'
let failures = 0

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try { data = await res.json() } catch { /* text */ }
  return { status: res.status, data }
}

async function step(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (e) {
    failures++
    console.log(`FAIL ${name}\n     ${e.message}`)
  }
}

function d1(sql) {
  // SQL here is test-controlled (no user input) and only uses single quotes.
  const out = execSync(`npx wrangler@4 d1 execute glance-desk --local --json --command "${sql}"`, {
    cwd: new URL('../worker/', import.meta.url), encoding: 'utf8',
  })
  return JSON.parse(out)[0].results
}

const tgUpdate = (id, chat, from, text) => ({
  update_id: id,
  message: { message_id: id, date: Math.floor(Date.now() / 1000), chat, from, text },
})
const OWNER = { id: 9001, is_bot: false, first_name: 'Alex' }
const MARCO = { id: 9002, is_bot: false, first_name: 'Marco' }
const GROUP = { id: -100777, type: 'supergroup', title: 'Ops test' }

let demo
await step('unauthenticated API is rejected', async () => {
  const r = await call('GET', '/api/queue')
  assert.equal(r.status, 401)
})

await step('demo creates a token and a queue with 3 cards and 2 quiet threads', async () => {
  const r = await call('POST', '/api/demo')
  assert.equal(r.status, 200)
  demo = r.data.token
  const q = await call('GET', '/api/queue', { token: demo })
  assert.equal(q.status, 200)
  assert.equal(q.data.cards.length, 3, JSON.stringify(q.data.cards.map(c => c.chatTitle)))
  assert.equal(q.data.quietCount, 2)
  assert.equal(q.data.cards[0].chatTitle, 'Dev team') // urgent first
  for (const c of q.data.cards) assert.equal(c.drafts.length, 3)
})

await step('queue is stable on the second call (no re-triage)', async () => {
  const a = await call('GET', '/api/queue', { token: demo })
  const b = await call('GET', '/api/queue', { token: demo })
  assert.deepEqual(a.data.cards.map(c => c.id), b.data.cards.map(c => c.id))
})

await step('send on a demo card closes it; later moves it last; done closes it', async () => {
  const q = (await call('GET', '/api/queue', { token: demo })).data
  const [first, second] = q.cards
  assert.equal((await call('POST', `/api/cards/${first.id}/later`, { token: demo })).status, 200)
  const q2 = (await call('GET', '/api/queue', { token: demo })).data
  assert.equal(q2.cards[q2.cards.length - 1].id, first.id)
  assert.equal((await call('POST', `/api/cards/${second.id}/send`, { token: demo, body: { text: 'Ok, alle 9.' } })).status, 200)
  assert.equal((await call('POST', `/api/cards/${second.id}/send`, { token: demo, body: { text: 'again' } })).status, 404)
  assert.equal((await call('POST', `/api/cards/${first.id}/done`, { token: demo })).status, 200)
  const q3 = (await call('GET', '/api/queue', { token: demo })).data
  assert.equal(q3.cards.length, 1)
})

await step('empty reply is refused', async () => {
  const q = (await call('GET', '/api/queue', { token: demo })).data
  assert.equal((await call('POST', `/api/cards/${q.cards[0].id}/send`, { token: demo, body: { text: '  ' } })).status, 400)
})

await step('digest falls back to one line per quiet thread', async () => {
  const r = await call('GET', '/api/digest', { token: demo })
  assert.equal(r.status, 200)
  assert.equal(r.data.lines.length, 2)
})

await step('another token cannot touch these cards', async () => {
  const other = (await call('POST', '/api/demo')).data.token
  const q = (await call('GET', '/api/queue', { token: demo })).data
  assert.equal((await call('POST', `/api/cards/${q.cards[0].id}/done`, { token: other })).status, 404)
})

await step('webhook rejects a wrong secret', async () => {
  const r = await call('POST', '/tg/webhook', { body: tgUpdate(1, GROUP, MARCO, 'hi'), headers: { 'x-telegram-bot-api-secret-token': 'nope' } })
  assert.equal(r.status, 401)
})

const hook = body => call('POST', '/tg/webhook', { body, headers: { 'x-telegram-bot-api-secret-token': SECRET } })
let real
await step('Telegram flow: /start -> code -> pair -> /watch -> message -> card -> owner reply closes it', async () => {
  await hook(tgUpdate(10, { id: OWNER.id, type: 'private' }, OWNER, '/start'))
  const code = d1(`SELECT p.code FROM pair_codes p JOIN users u ON u.id = p.user_id WHERE u.tg_user_id = '${OWNER.id}'`)[0].code
  assert.match(code, /^\d{6}$/)
  assert.equal((await call('POST', '/api/pair', { body: { code: '000000x' } })).status, 400)
  const paired = await call('POST', '/api/pair', { body: { code } })
  assert.equal(paired.status, 200)
  real = paired.data.token
  assert.equal((await call('POST', '/api/pair', { body: { code } })).status, 400) // single use

  await hook(tgUpdate(11, GROUP, MARCO, 'Before watch: ignored'))
  await hook(tgUpdate(12, GROUP, OWNER, '/watch@GlanceDeskBot'))
  await hook(tgUpdate(13, GROUP, MARCO, 'Il cliente chiede se possiamo consegnare entro oggi?'))
  const q = (await call('GET', '/api/queue', { token: real })).data
  assert.equal(q.cards.length, 1)
  assert.equal(q.cards[0].chatTitle, 'Ops test')
  assert.match(q.cards[0].snippet, /entro oggi/)
  assert.equal(q.cards[0].urgency, 2)

  await hook(tgUpdate(14, GROUP, OWNER, 'Sì, ci penso io'))
  const q2 = (await call('GET', '/api/queue', { token: real })).data
  assert.equal(q2.cards.length, 0)
})

await step('new messages replace the open card of that chat', async () => {
  await hook(tgUpdate(15, GROUP, MARCO, 'Il server è giù?'))
  const a = (await call('GET', '/api/queue', { token: real })).data.cards
  await hook(tgUpdate(16, GROUP, MARCO, 'URGENTE: risolto? serve subito'))
  const b = (await call('GET', '/api/queue', { token: real })).data.cards
  assert.equal(a.length, 1)
  assert.equal(b.length, 1)
  assert.notEqual(a[0].id, b[0].id)
  assert.equal(b[0].urgency, 3)
})

await step('/unwatch deletes the chat data', async () => {
  await hook(tgUpdate(17, GROUP, OWNER, '/unwatch'))
  assert.equal(d1(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = '${GROUP.id}'`)[0].n, 0)
  assert.equal((await call('GET', '/api/queue', { token: real })).data.cards.length, 0)
})

await step('dictation without Workers AI reports a clear error', async () => {
  const q = (await call('GET', '/api/queue', { token: demo })).data
  const r = await call('POST', `/api/cards/${q.cards[0].id}/dictate`, { token: demo, body: { draft: 'x', audio: 'UklGRg==' } })
  assert.ok([502, 422].includes(r.status), String(r.status))
})

await step('CORS preflight is answered', async () => {
  const res = await fetch(BASE + '/api/queue', { method: 'OPTIONS' })
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
})

console.log(failures ? `\n${failures} failing` : '\nall passing')
process.exit(failures ? 1 : 0)
