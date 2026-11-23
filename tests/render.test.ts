import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Card } from '../app/src/core/types.ts'
import { initialState, loaded, move, tap, failed, digestLoaded, startListening, sendResult, armExpired } from '../app/src/core/desk.ts'
import { screen, sanitize, clip, urgencyBar, LAYOUT, LIMITS } from '../app/src/core/render.ts'

function card(over: Partial<Card> = {}): Card {
  return {
    id: 'a', chatTitle: 'Ops Molfetta', from: 'Marco Rossi', category: 'needs_you', urgency: 3,
    summary: 'Needs the pickup time for the Bari order', snippet: 'A che ora passo a ritirare? 🚚',
    drafts: ['Alle 10 va bene.', 'Domani pomeriggio.', 'Ti chiamo tra 5 minuti.'], source: 'ai', at: 1, ...over,
  }
}

test('sanitize drops emoji and control chars but keeps accents and our glyphs', () => {
  assert.equal(sanitize('Ciao 👋 perché ▶ ok\u0007'), 'Ciao perché ▶ ok')
  assert.equal(sanitize('a\r\nb'), 'a\nb')
})

test('clip adds an ellipsis only when needed', () => {
  assert.equal(clip('short', 10), 'short')
  assert.equal(clip('exactly10!', 10), 'exactly10!')
  assert.equal(clip('this is too long', 10), 'this is...')
})

// Printable ASCII, newline, Latin-1 (accents, middle dot) and the glyphs the Even docs list.
const ALLOWED = /^[ -~\n -ÿ●○■▶▲▼]$/u

test('our UI strings only use glyphs from the documented firmware set', () => {
  const s = loaded(initialState(), { cards: [card({ snippet: 'ok', summary: 'ok' })], quietCount: 1 })
  const views = [screen(s), screen(move(s, 3)), screen(move(s, 4)), screen(tap(s)[0]),
    screen(loaded(initialState(), { cards: [], quietCount: 1 })), screen(startListening(s))]
  for (const v of views) for (const t of Object.values(v)) {
    for (const ch of t) assert.ok(ALLOWED.test(ch), `glyph ${ch} in ${t}`)
  }
})

test('urgency bar has 3 slots', () => {
  assert.equal(urgencyBar(0), '○○○')
  assert.equal(urgencyBar(2), '●●○')
  assert.equal(urgencyBar(9), '●●●')
})

test('card screen shows count, chat, sender, summary, snippet and the selected draft', () => {
  const s = loaded(initialState(), { cards: [card(), card({ id: 'b' })], quietCount: 5 })
  const v = screen(s)
  assert.match(v.header, /NEEDS YOU/)
  assert.match(v.header, /1\/2/)
  assert.match(v.header, /●●●/)
  assert.match(v.meta, /Ops Molfetta/)
  assert.match(v.meta, /Marco Rossi/)
  assert.match(v.body, /pickup time/)
  assert.match(v.body, /A che ora passo a ritirare\?/)
  assert.doesNotMatch(v.body, /🚚/)
  assert.match(v.reply, /▶ 1\/3/)
  assert.match(v.reply, /Alle 10 va bene\./)
})

test('selecting Later shows it as the reply option', () => {
  const s = move(loaded(initialState(), { cards: [card()], quietCount: 0 }), 3)
  assert.match(screen(s).reply, /Later/)
})

test('arming tells the user how to cancel', () => {
  const [s] = tap(loaded(initialState(), { cards: [card()], quietCount: 0 }))
  const v = screen(s)
  assert.match(v.reply, /Alle 10/)
  assert.match(v.footer, /tap to cancel/i)
})

test('sent and send-error messages appear in the footer', () => {
  const base = loaded(initialState(), { cards: [card()], quietCount: 0 })
  const [sending] = armExpired(tap(base)[0])
  assert.match(screen(sendResult(sending, true)).body, /Sent to Ops Molfetta/)
  assert.match(screen(sendResult(sending, false, 'Bot not in chat')).footer, /Bot not in chat/)
})

test('empty, digest, listening, loading and error screens have their own text', () => {
  const empty = loaded(initialState(), { cards: [], quietCount: 4 })
  assert.match(screen(empty).body, /All clear/)
  assert.match(screen(empty).body, /4 quiet/)
  assert.match(screen(digestLoaded(empty, ['Sales: 2 new leads', 'IT: backup ok'])).body, /Sales: 2 new leads\nIT: backup ok/)
  const listening = startListening(loaded(initialState(), { cards: [card()], quietCount: 0 }))
  assert.match(screen(listening).reply, /Listening/)
  assert.match(screen(initialState()).body, /Loading/)
  assert.match(screen(failed(initialState(), 'Offline')).body, /Offline/)
})

test('every field respects the per-container character limits', () => {
  const huge = 'x'.repeat(5000)
  const s = loaded(initialState(), {
    cards: [card({ chatTitle: huge, from: huge, summary: huge, snippet: huge, drafts: [huge] })], quietCount: 0,
  })
  const v = screen(s)
  for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    assert.ok(v[key].length <= LIMITS[key], `${key} is ${v[key].length} > ${LIMITS[key]}`)
  }
  const total = Object.values(v).reduce((n, t) => n + t.length, 0)
  assert.ok(total <= 1000, `total ${total} > 1000 (createStartUpPageContainer limit)`)
})

test('layout fits the 576x288 canvas with exactly one event-capture container', () => {
  for (const box of Object.values(LAYOUT)) {
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= 576 && box.y + box.h <= 288)
  }
  assert.equal(Object.values(LAYOUT).filter(b => b.capture).length, 1)
  assert.ok(Object.values(LAYOUT).every(b => b.name.length <= 16))
})
