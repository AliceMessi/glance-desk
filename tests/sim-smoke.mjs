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
  return entries.filter(e => e.level === 'error' || /Unhandled|Uncaught|failed fetch/i.test(e.message))
}

let failures = 0
function check(ok, label) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const pong = await fetch(`${SIM}/api/ping`).then(r => r.text()).catch(() => '')
check(/pong/.test(pong), 'simulator is up')
await sleep(4000) // SDK init + createStartUpPageContainer + demo queue

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

// Teammate scene: the demo has a second person, Nina. She takes the thread on screen;
// the wearer's next gesture loses it, and the card is replaced by the next one.
const API = process.env.API_BASE ?? 'https://glance-desk.infocryptorepublic.workers.dev'
const { entries } = await (await fetch(`${SIM}/api/console`)).json()
const nina = entries.map(e => e.message.match(/\[demo\] teammate token (\S+)/)?.[1]).filter(Boolean).pop()
check(Boolean(nina), 'demo teammate token is in the console')
const ninaQueue = await (await fetch(`${API}/api/queue`, { headers: { authorization: `Bearer ${nina}` } })).json()
const devCard = ninaQueue.cards.find(c => c.chatTitle === 'Dev team')
const claim = await fetch(`${API}/api/cards/${devCard.id}/claim`, { method: 'POST', headers: { authorization: `Bearer ${nina}` } })
check(claim.status === 200, 'Nina takes the Dev team thread')
await input('down')
await sleep(1500)
const taken = await shot('05-taken-by-nina')
check(taken !== cancelled, 'the wearer\'s next swipe drops the card Nina took and shows the next one')

await input('click')
await sleep(2600)
await shot('06-sent-signed')
await sleep(1600)
const after = await shot('07-all-clear-team')
check(after !== taken, 'after sending, the all-clear screen names what Nina is answering')

await input('context_menu')
await sleep(700)
await shot('08-menu')
await input('context_menu')
await sleep(500)

const errors = await consoleErrors()
check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.map(e => e.message).join(' | ') : ''}`)

console.log(failures ? `\n${failures} failing` : '\nall passing')
process.exit(failures ? 1 : 0)
