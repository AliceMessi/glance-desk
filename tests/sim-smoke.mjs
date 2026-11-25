// Drives the Even Hub simulator through its automation API and saves screenshots.
// Start the dev server and the simulator in demo mode first (the demo team: Alex wears the glasses, Nina is a teammate):
//   cd app && npm run dev
//   evenhub-simulator "http://127.0.0.1:5173/?demo" --automation-port 9898
// Usage: node tests/sim-smoke.mjs [outDir]

import { writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'

const SIM = 'http://127.0.0.1:9898'
const OUT = process.argv[2] ?? 'media/smoke'
mkdirSync(OUT, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const input = action => fetch(`${SIM}/api/input`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
}).then(r => r.json())

async function shot(name) {
  const buf = Buffer.from(await (await fetch(`${SIM}/api/screenshot/glasses`)).arrayBuffer())
  writeFileSync(`${OUT}/${name}.png`, buf)
  return createHash('sha1').update(buf).digest('hex')
}

async function consoleErrors() {
  const { entries } = await (await fetch(`${SIM}/api/console`)).json()
  // A 409 on a card action is the expected answer when a teammate holds the thread (the app handles it).
  return entries
    .filter(e => e.level === 'error' || /Unhandled|Uncaught|failed fetch/i.test(e.message))
    // Local wrangler logs "409 Conflict <url>", the hosted Worker (HTTP/2, no status text) "409  <url>".
    .filter(e => !/\b409\b.*\/api\/cards\/[\w-]+\/(claim|send|dictate|done|later)$/.test(e.message))
}

let failures = 0
function check(ok, label) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const pong = await fetch(`${SIM}/api/ping`).then(r => r.text()).catch(() => '')
check(/pong/.test(pong), 'simulator is up')
await sleep(Number(process.env.BOOT_MS ?? 4000)) // SDK init + createStartUpPageContainer + demo queue (BOOT_MS=15000 when triage runs on a slow model)

const boot = await shot('01-card')
await input('down')
await sleep(700)
const next = await shot('02-next-draft')
check(boot !== next, 'swipe down changes the selected draft')

await input('click')
await sleep(600)
const arming = await shot('03-arming')
check(arming !== next, 'tap arms the send (cancel window)')
await input('click')
await sleep(600)
const cancelled = await shot('04-cancelled')
check(cancelled === next, 'second tap cancels and restores the card')

// Teammate scene. The demo has a second person, Nina. Alex's gestures above took the thread on screen,
// so Nina can't take it; she takes the other open thread instead, and Alex finds it gone after sending.
const API = process.env.API_BASE ?? 'https://glance-desk.infocryptorepublic.workers.dev'
const { entries } = await (await fetch(`${SIM}/api/console`)).json()
const nina = entries.map(e => e.message.match(/\[demo\] teammate token (\S+)/)?.[1]).filter(Boolean).pop()
check(Boolean(nina), 'demo teammate token is in the console')
const asNina = (path, method = 'GET') => fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${nina}` } })
const ninaQueue = await (await asNina('/api/queue')).json()
const alexHas = ninaQueue.taken?.find(t => t.by === 'Alex')
check(Boolean(alexHas), `Nina's glasses show that Alex is answering ${alexHas?.chatTitle}`)
const other = ninaQueue.cards.find(c => c.chatTitle !== 'Ops · Warehouse')
const claim = await asNina(`/api/cards/${other.id}/claim`, 'POST')
check(claim.status === 200, `Nina takes ${other.chatTitle}`)

await input('click')
await sleep(2600)
const sent = await shot('05-sent-signed')
check(sent !== cancelled, 'Alex sends; the confirmation shows the signature')
await sleep(1600)
await shot('06-next-card')
await input('down')
await sleep(1500)
const taken = await shot('07-taken-by-nina')
check(taken !== sent, 'Alex\'s next swipe finds the thread taken by Nina and lands on all clear')

await input('context_menu')
await sleep(700)
await shot('08-menu')
await input('context_menu')
await sleep(500)

const errors = await consoleErrors()
check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.map(e => e.message).join(' | ') : ''}`)

console.log(failures ? `\n${failures} failing` : '\nall passing')
process.exit(failures ? 1 : 0)
