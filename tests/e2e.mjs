// End-to-end check against a running Worker (default: wrangler dev on 127.0.0.1:8787).
// Usage: node tests/e2e.mjs [baseUrl]
// worker/.dev.vars needs TG_WEBHOOK_SECRET=local-test-secret, TG_TOKEN=test-token and TG_API=http://127.0.0.1:8790:
// this script starts a Telegram stand-in on that port (tests/tg-mock.mjs) and checks what the bot really sends.
// Without OPENROUTER_KEY the Worker uses Workers AI (always remote, even in wrangler dev), then the heuristic;
// assertions on triage output accept both.

import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { startTelegramMock } from './tg-mock.mjs'

const tg = await startTelegramMock()
tg.admins.add(9001).add(9003) // Alex and Nina are group admins; Marco is not

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

// Local D1 only (wrangler dev --local): start from empty tables so a failed earlier run can't leak into this one.
for (const t of ['counters', 'claims', 'chat_members', 'business_connections', 'cards', 'messages', 'chats', 'pair_codes', 'devices', 'users']) d1(`DELETE FROM ${t}`)

let demo
await step('unauthenticated API is rejected', async () => {
  const r = await call('GET', '/api/queue')
  assert.equal(r.status, 401)
})

let nina
await step('demo: teammate Nina is answering the warehouse thread, so Alex sees 2 cards', async () => {
  const r = await call('POST', '/api/demo')
  assert.equal(r.status, 200)
  demo = r.data.token
  nina = r.data.teammateToken
  assert.ok(nina)
  const q = await call('GET', '/api/queue', { token: demo })
  assert.equal(q.status, 200)
  assert.equal(q.data.cards.length, 2, JSON.stringify(q.data.cards.map(c => c.chatTitle)))
  assert.deepEqual(q.data.taken, [{ chatTitle: 'Ops · Warehouse', by: 'Nina' }])
  assert.equal(q.data.quietCount, 2)
  const n = (await call('GET', '/api/queue', { token: nina })).data
  assert.equal(n.cards.length, 3) // her own claim stays visible to her
  assert.deepEqual(n.taken, [])
})

await step('demo: when Nina lets the thread go (Later), Alex sees all 3 cards', async () => {
  const ops = (await call('GET', '/api/queue', { token: nina })).data.cards.find(c => c.chatTitle === 'Ops · Warehouse')
  assert.equal((await call('POST', `/api/cards/${ops.id}/later`, { token: nina })).status, 200)
  const q = (await call('GET', '/api/queue', { token: demo })).data
  assert.equal(q.cards.length, 3, JSON.stringify(q.cards.map(c => c.chatTitle)))
  assert.deepEqual(q.taken, [])
  assert.ok(q.cards[0].urgency >= q.cards[q.cards.length - 1].urgency) // most urgent first
  for (const c of q.cards) assert.equal(c.drafts.length, 3)
})

await step('claim: the first teammate to act takes the thread; the other gets 409 with their name', async () => {
  const dev = (await call('GET', '/api/queue', { token: demo })).data.cards.find(c => c.chatTitle === 'Dev team')
  assert.equal((await call('POST', `/api/cards/${dev.id}/claim`, { token: demo })).status, 200)
  assert.equal((await call('POST', `/api/cards/${dev.id}/claim`, { token: demo })).status, 200) // re-claim by holder is fine
  const lost = await call('POST', `/api/cards/${dev.id}/claim`, { token: nina })
  assert.equal(lost.status, 409)
  assert.equal(lost.data.by, 'Alex')
  assert.match(lost.data.error, /Alex is answering/)
  const sendLost = await call('POST', `/api/cards/${dev.id}/send`, { token: nina, body: { text: 'Roll back.' } })
  assert.equal(sendLost.status, 409)
  const n = (await call('GET', '/api/queue', { token: nina })).data
  assert.ok(!n.cards.some(c => c.id === dev.id))
  assert.deepEqual(n.taken, [{ chatTitle: 'Dev team', by: 'Alex' }])
})

await step('claim: a send is signed by who approved it, and the teammate learns it was answered', async () => {
  const dev = (await call('GET', '/api/queue', { token: demo })).data.cards.find(c => c.chatTitle === 'Dev team')
  const sent = await call('POST', `/api/cards/${dev.id}/send`, { token: demo, body: { text: 'Yes, roll back now please.' } })
  assert.equal(sent.status, 200)
  assert.equal(sent.data.signedAs, 'Alex')
  const late = await call('POST', `/api/cards/${dev.id}/send`, { token: nina, body: { text: 'Roll back.' } })
  assert.equal(late.status, 409)
  assert.match(late.data.error, /Alex already answered/)
  assert.equal(late.data.by, 'Alex')
  assert.equal((await call('GET', '/api/queue', { token: nina })).data.taken.length, 0)
  const own = await call('POST', `/api/cards/${dev.id}/send`, { token: demo, body: { text: 'again' } })
  assert.equal(own.status, 409)
  assert.equal(own.data.by, '') // your own earlier send is not "a teammate took it"
})

await step('claim: an expired claim can be taken over', async () => {
  const client = (await call('GET', '/api/queue', { token: demo })).data.cards.find(c => c.chatTitle.startsWith('Client'))
  assert.equal((await call('POST', `/api/cards/${client.id}/claim`, { token: nina })).status, 200)
  assert.equal((await call('POST', `/api/cards/${client.id}/claim`, { token: demo })).status, 409)
  d1('UPDATE claims SET expires_at = 0')
  assert.equal((await call('POST', `/api/cards/${client.id}/claim`, { token: demo })).status, 200)
  // Reset the demo to its usual shape for the steps below: 3 open cards, nobody holding them.
  d1(`UPDATE cards SET status = 'open' WHERE status = 'sent'`)
  d1('DELETE FROM claims')
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
  assert.equal((await call('POST', `/api/cards/${second.id}/send`, { token: demo, body: { text: 'again' } })).status, 409) // already answered
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
  assert.ok(q.cards[0].urgency >= 2, String(q.cards[0].urgency)) // 'entro oggi': 2 from the heuristic, the remote model may say 3

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

await step('send: Telegram refusing a reply keeps the card open for another try', async () => {
  const card = (await call('GET', '/api/queue', { token: real })).data.cards[0]
  const r = await call('POST', `/api/cards/${card.id}/send`, { token: real, body: { text: 'FAIL this one' } })
  assert.equal(r.status, 502, JSON.stringify(r.data))
  assert.ok((await call('GET', '/api/queue', { token: real })).data.cards.some(c => c.id === card.id))
})

await step('send: a card stuck mid-send (Worker died) comes back, flagged, instead of vanishing', async () => {
  const card = (await call('GET', '/api/queue', { token: real })).data.cards[0]
  d1(`UPDATE cards SET status = 'sending', updated_at = 0 WHERE id = '${card.id}'`)
  const back = (await call('GET', '/api/queue', { token: real })).data.cards.find(c => c.id === card.id)
  assert.ok(back, 'stuck card is back in the queue')
  assert.match(back.summary, /^Check: may be sent/)
})

await step('send: a group reply goes out from the bot, signed, threaded to the last message', async () => {
  const card = (await call('GET', '/api/queue', { token: real })).data.cards[0]
  const before = tg.sent().length
  const r = await call('POST', `/api/cards/${card.id}/send`, { token: real, body: { text: 'Ci penso io.' } })
  assert.equal(r.status, 200)
  const body = tg.sent().slice(before).pop()
  assert.equal(body.chat_id, String(GROUP.id))
  assert.equal(body.text, 'Ci penso io.\n— Alex')
  assert.ok(body.reply_parameters?.message_id > 0)
  assert.equal((await call('GET', '/api/queue', { token: real })).data.cards.length, 0)
})

const MARCO_PAIRED = { ...MARCO }
await step('team: someone who is not a group admin cannot /watch, so a client cannot join the team', async () => {
  await hook(tgUpdate(20, { id: MARCO.id, type: 'private' }, MARCO_PAIRED, '/start'))
  const code = d1(`SELECT p.code FROM pair_codes p JOIN users u ON u.id = p.user_id WHERE u.tg_user_id = '${MARCO.id}'`)[0].code
  assert.equal((await call('POST', '/api/pair', { body: { code } })).status, 200)
  const before = tg.sent().length
  await hook(tgUpdate(21, GROUP, MARCO, '/watch'))
  assert.equal(d1(`SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = '${GROUP.id}'`)[0].n, 1)
  assert.match(tg.sent().slice(before).pop()?.text ?? '', /Only group admins/)
})

const NINA = { id: 9003, is_bot: false, first_name: 'Nina', last_name: 'Rossi' }
let ninaReal
await step('team: a second paired person joins the watched group and shares the same card', async () => {
  await hook(tgUpdate(30, { id: NINA.id, type: 'private' }, NINA, '/start'))
  const code = d1(`SELECT p.code FROM pair_codes p JOIN users u ON u.id = p.user_id WHERE u.tg_user_id = '${NINA.id}'`)[0].code
  ninaReal = (await call('POST', '/api/pair', { body: { code } })).data.token
  await hook(tgUpdate(31, GROUP, NINA, '/watch'))
  assert.equal(d1(`SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = '${GROUP.id}'`)[0].n, 2)
  await hook(tgUpdate(32, GROUP, MARCO, 'Chi mi conferma il ritiro di domani?'))
  const a = (await call('GET', '/api/queue', { token: real })).data.cards
  const b = (await call('GET', '/api/queue', { token: ninaReal })).data.cards
  assert.equal(a.length, 1)
  assert.deepEqual(b.map(c => c.id), a.map(c => c.id))
})

await step('team: a reply from either person on the phone closes the card for both', async () => {
  await hook(tgUpdate(33, GROUP, NINA, 'Confermo io, a domani'))
  assert.equal((await call('GET', '/api/queue', { token: real })).data.cards.length, 0)
  assert.equal((await call('GET', '/api/queue', { token: ninaReal })).data.cards.length, 0)
})

await step('team: when one person unwatches, the other keeps the chat and its messages', async () => {
  await hook(tgUpdate(34, GROUP, NINA, '/unwatch'))
  assert.equal(d1(`SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = '${GROUP.id}'`)[0].n, 1)
  await hook(tgUpdate(35, GROUP, MARCO, 'Ok, e la fattura?'))
  assert.equal((await call('GET', '/api/queue', { token: real })).data.cards.length, 1)
  assert.equal((await call('GET', '/api/queue', { token: ninaReal })).data.cards.length, 0)
})

const CLIENT = { id: 555, is_bot: false, first_name: 'Laura', last_name: 'Bianchi' }
const bizConn = (enabled, user = OWNER) => ({
  update_id: 40, business_connection: { id: 'BC-e2e', user, user_chat_id: user.id, date: 1, rights: { can_reply: true }, is_enabled: enabled },
})
const bizMsg = (id, from, text) => ({
  update_id: id,
  business_message: {
    message_id: id, date: Math.floor(Date.now() / 1000), business_connection_id: 'BC-e2e',
    chat: { id: CLIENT.id, type: 'private', first_name: 'Laura', last_name: 'Bianchi' }, from, text,
  },
})
await step('business: a connection from someone who never paired is ignored', async () => {
  await hook(bizConn(true, { id: 9999, is_bot: false, first_name: 'Stranger' }))
  assert.equal(d1(`SELECT COUNT(*) AS n FROM business_connections`)[0].n, 0)
  await hook(bizMsg(41, CLIENT, 'Ciao, ci fate lo sconto?'))
  assert.equal(d1(`SELECT COUNT(*) AS n FROM messages WHERE chat_id LIKE 'biz:%'`)[0].n, 0)
})

await step('business: a client\'s private message becomes a card for the connected person', async () => {
  await hook(bizConn(true))
  await hook(bizMsg(42, CLIENT, 'Ciao, se ci fate il 5% confermiamo l\'ordine entro oggi?'))
  const q = (await call('GET', '/api/queue', { token: real })).data
  const card = q.cards.find(c => c.chatTitle === 'Laura Bianchi')
  assert.ok(card, JSON.stringify(q.cards.map(c => c.chatTitle)))
  assert.equal(d1(`SELECT business_connection_id AS b FROM chats WHERE chat_id = 'biz:BC-e2e:555'`)[0].b, 'BC-e2e')
})

await step('business: a reply approved on the glasses goes out as the person, unsigned', async () => {
  const card = (await call('GET', '/api/queue', { token: real })).data.cards.find(c => c.chatTitle === 'Laura Bianchi')
  const before = tg.sent().length
  assert.equal((await call('POST', `/api/cards/${card.id}/send`, { token: real, body: { text: 'Vi richiamo entro le 12.' } })).status, 200)
  const body = tg.sent().slice(before).pop()
  assert.deepEqual([body.chat_id, body.business_connection_id, body.text], ['555', 'BC-e2e', 'Vi richiamo entro le 12.'])
  await hook(bizMsg(45, CLIENT, 'Perfetto, e se ci fate il 5%?'))
})

await step('business: answering the client from the phone closes the card', async () => {
  await hook(bizMsg(43, OWNER, 'Sì, va bene'))
  const q = (await call('GET', '/api/queue', { token: real })).data
  assert.ok(!q.cards.some(c => c.chatTitle === 'Laura Bianchi'))
})

await step('business: disconnecting the bot deletes those chats and messages', async () => {
  await hook(bizMsg(44, CLIENT, 'Grazie! E la consegna?'))
  await hook(bizConn(false))
  assert.equal(d1(`SELECT COUNT(*) AS n FROM business_connections`)[0].n, 0)
  assert.equal(d1(`SELECT COUNT(*) AS n FROM chats WHERE chat_id LIKE 'biz:%'`)[0].n, 0)
  assert.equal(d1(`SELECT COUNT(*) AS n FROM messages WHERE chat_id LIKE 'biz:%'`)[0].n, 0)
  assert.ok(!(await call('GET', '/api/queue', { token: real })).data.cards.some(c => c.chatTitle === 'Laura Bianchi'))
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

await step('team: two people opening the queue at the same time get the same cards, triaged once', async () => {
  const d = (await call('POST', '/api/demo')).data
  const [a, b] = await Promise.all([call('GET', '/api/queue', { token: d.token }), call('GET', '/api/queue', { token: d.teammateToken })])
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  const again = (await call('GET', '/api/queue', { token: d.token })).data
  // Every card id Alex was shown must still be live: a second triage would have replaced it (404 on any action).
  for (const c of a.data.cards) assert.ok(again.cards.some(x => x.id === c.id), `card ${c.chatTitle} was replaced`)
  const tag = d1(`SELECT tg_user_id FROM users u JOIN devices v ON v.user_id = u.id ORDER BY u.id DESC LIMIT 1`)[0].tg_user_id.replace(/-nina$/, '')
  assert.equal(d1(`SELECT COUNT(*) AS n FROM cards WHERE chat_id LIKE '${tag}:%' AND status = 'replaced'`)[0].n, 0)
})

await step('CORS preflight is answered', async () => {
  const res = await fetch(BASE + '/api/queue', { method: 'OPTIONS' })
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
})

await tg.close()
console.log(failures ? `\n${failures} failing` : '\nall passing')
process.exit(failures ? 1 : 0)
