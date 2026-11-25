import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Card } from '../app/src/core/types.ts'
import {
  initialState, loaded, move, tap, armExpired, sendResult, settle, choicesFor,
  replaceDraft, startListening, stopListening, digestLoaded, failed, takenAway, LATER, DONE,
} from '../app/src/core/desk.ts'

function card(id: string, drafts = ['Ok', 'Tomorrow at 10', 'Call me']): Card {
  return {
    id, chatTitle: 'Ops', from: 'Marco', category: 'needs_you', urgency: 2,
    summary: 'Asks when to pick up', snippet: 'When can I pick up?', drafts, source: 'ai', at: 1,
  }
}

test('loaded with cards shows the first card with the first draft selected', () => {
  const s = loaded(initialState(), { cards: [card('a'), card('b')], quietCount: 4 })
  assert.equal(s.mode, 'card')
  assert.equal(s.index, 0)
  assert.equal(s.choice, 0)
  assert.equal(s.quietCount, 4)
})

test('loaded with no cards is the empty state', () => {
  const s = loaded(initialState(), { cards: [], quietCount: 2 })
  assert.equal(s.mode, 'empty')
})

test('choices are the drafts plus Later and Done', () => {
  assert.deepEqual(choicesFor(card('a', ['x', 'y'])), ['x', 'y', LATER, DONE])
})

test('move cycles through choices and wraps both ways', () => {
  let s = loaded(initialState(), { cards: [card('a')], quietCount: 0 })
  s = move(s, -1)
  assert.equal(s.choice, 4) // 3 drafts + Later + Done -> last index 4
  s = move(s, 1)
  assert.equal(s.choice, 0)
  s = move(move(s, 1), 1)
  assert.equal(s.choice, 2)
})

test('move is ignored outside card mode', () => {
  const s = loaded(initialState(), { cards: [], quietCount: 0 })
  assert.deepEqual(move(s, 1), s)
})

test('tap on a draft arms the send instead of sending at once', () => {
  const s = loaded(initialState(), { cards: [card('a')], quietCount: 0 })
  const [next, effect] = tap(move(s, 1))
  assert.equal(next.mode, 'arming')
  assert.deepEqual(effect, { kind: 'arm' })
})

test('tap while arming cancels', () => {
  const s = loaded(initialState(), { cards: [card('a')], quietCount: 0 })
  const [armed] = tap(s)
  const [cancelled, effect] = tap(armed)
  assert.equal(cancelled.mode, 'card')
  assert.deepEqual(effect, { kind: 'cancel' })
})

test('arm expiry sends the selected draft text', () => {
  const s = loaded(initialState(), { cards: [card('a')], quietCount: 0 })
  const [armed] = tap(move(s, 1))
  const [sending, effect] = armExpired(armed)
  assert.equal(sending.mode, 'sending')
  assert.deepEqual(effect, { kind: 'send', cardId: 'a', text: 'Tomorrow at 10' })
})

test('arm expiry after a cancel does nothing', () => {
  const s = loaded(initialState(), { cards: [card('a')], quietCount: 0 })
  const [armed] = tap(s)
  const [cancelled] = tap(armed)
  const [after, effect] = armExpired(cancelled)
  assert.deepEqual(after, cancelled)
  assert.deepEqual(effect, { kind: 'none' })
})

test('successful send removes the card, shows sent, then settles on the next card', () => {
  const s = loaded(initialState(), { cards: [card('a'), card('b')], quietCount: 0 })
  const [sending] = armExpired(tap(s)[0])
  const sent = sendResult(sending, true)
  assert.equal(sent.mode, 'sent')
  assert.deepEqual(sent.cards.map(c => c.id), ['b'])
  const settled = settle(sent)
  assert.equal(settled.mode, 'card')
  assert.equal(settled.cards[settled.index].id, 'b')
  assert.equal(settled.choice, 0)
})

test('successful send of the last card settles on empty', () => {
  const s = loaded(initialState(), { cards: [card('a')], quietCount: 0 })
  const [sending] = armExpired(tap(s)[0])
  assert.equal(settle(sendResult(sending, true)).mode, 'empty')
})

test('failed send keeps the card and shows the error message', () => {
  const s = loaded(initialState(), { cards: [card('a')], quietCount: 0 })
  const [sending] = armExpired(tap(s)[0])
  const after = sendResult(sending, false, 'Telegram said no')
  assert.equal(after.mode, 'card')
  assert.equal(after.cards.length, 1)
  assert.equal(after.message, 'Telegram said no')
})

test('Later moves the card to the end without sending', () => {
  let s = loaded(initialState(), { cards: [card('a'), card('b')], quietCount: 0 })
  s = move(s, 3) // Later
  const [next, effect] = tap(s)
  assert.deepEqual(effect, { kind: 'later', cardId: 'a' })
  assert.deepEqual(next.cards.map(c => c.id), ['b', 'a'])
  assert.equal(next.index, 0)
  assert.equal(next.choice, 0)
  assert.equal(next.mode, 'card')
})

test('Done removes the card without sending', () => {
  let s = loaded(initialState(), { cards: [card('a'), card('b')], quietCount: 0 })
  s = move(s, -1) // Done
  const [next, effect] = tap(s)
  assert.deepEqual(effect, { kind: 'done', cardId: 'a' })
  assert.deepEqual(next.cards.map(c => c.id), ['b'])
})

test('tap on empty asks for the digest, tap on the digest goes back', () => {
  const empty = loaded(initialState(), { cards: [], quietCount: 3 })
  const [thinking, effect] = tap(empty)
  assert.deepEqual(effect, { kind: 'digest' })
  assert.equal(thinking.mode, 'thinking')
  const digest = digestLoaded(thinking, ['Line 1', 'Line 2'])
  assert.equal(digest.mode, 'digest')
  assert.deepEqual(digest.digest, ['Line 1', 'Line 2'])
  const [back, effect2] = tap(digest)
  assert.equal(back.mode, 'empty')
  assert.deepEqual(effect2, { kind: 'none' })
})

test('dictation replaces the selected draft and selects it', () => {
  let s = loaded(initialState(), { cards: [card('a')], quietCount: 0 })
  s = move(s, 1)
  s = startListening(s)
  assert.equal(s.mode, 'listening')
  s = stopListening(s)
  assert.equal(s.mode, 'thinking')
  s = replaceDraft(s, 'Tomorrow at 11 instead')
  assert.equal(s.mode, 'card')
  assert.equal(s.choice, 1)
  assert.equal(s.cards[0].drafts[1], 'Tomorrow at 11 instead')
  assert.equal(s.cards[0].source, 'ai')
})

test('dictation while Later/Done is selected puts the new draft first', () => {
  let s = loaded(initialState(), { cards: [card('a')], quietCount: 0 })
  s = move(s, 3)
  s = replaceDraft(stopListening(startListening(s)), 'New text')
  assert.equal(s.choice, 0)
  assert.deepEqual(s.cards[0].drafts, ['New text', 'Ok', 'Tomorrow at 10'])
})

test('listening only starts from a card', () => {
  const empty = loaded(initialState(), { cards: [], quietCount: 0 })
  assert.equal(startListening(empty).mode, 'empty')
})

test('failed() shows an error and tap asks for a refresh', () => {
  const s = failed(initialState(), 'Offline')
  assert.equal(s.mode, 'error')
  const [next, effect] = tap(s)
  assert.equal(next.mode, 'loading')
  assert.deepEqual(effect, { kind: 'refresh' })
})

test('reducers never mutate the previous state', () => {
  const s = loaded(initialState(), { cards: [card('a'), card('b')], quietCount: 0 })
  const snapshot = JSON.stringify(s)
  tap(move(s, 3))
  replaceDraft(stopListening(startListening(s)), 'x')
  assert.equal(JSON.stringify(s), snapshot)
})

test('loaded keeps the threads a teammate is answering', () => {
  const s = loaded(initialState(), { cards: [card('a')], quietCount: 1, taken: [{ chatTitle: 'Client', by: 'Nina' }] })
  assert.deepEqual(s.taken, [{ chatTitle: 'Client', by: 'Nina' }])
  assert.deepEqual(loaded(initialState(), { cards: [], quietCount: 0 }).taken, [])
})

test('a card a teammate took is removed, with their name, and the next card is shown', () => {
  let s = loaded(initialState(), { cards: [card('a'), card('b')], quietCount: 0 })
  s = move(s, 1)
  const after = takenAway(s, 'a', 'Nina', 'Client')
  assert.equal(after.mode, 'card')
  assert.deepEqual(after.cards.map(c => c.id), ['b'])
  assert.equal(after.choice, 0)
  assert.match(after.message, /Nina is answering/)
  assert.deepEqual(after.taken, [{ chatTitle: 'Client', by: 'Nina' }])
})

test('losing the last card while arming lands on empty, never on a send', () => {
  const s = loaded(initialState(), { cards: [card('a')], quietCount: 0 })
  const [arming] = tap(s)
  const after = takenAway(arming, 'a', 'Nina', 'Ops')
  assert.equal(after.mode, 'empty')
  assert.deepEqual(armExpired(after)[1], { kind: 'none' })
})

test('losing a card that is not on screen keeps the current card and choice', () => {
  let s = loaded(initialState(), { cards: [card('a'), card('b')], quietCount: 0 })
  s = move(s, 2)
  const after = takenAway(s, 'b', 'Nina', 'Ops')
  assert.equal(after.cards[after.index].id, 'a')
  assert.equal(after.choice, 2)
})

test('a successful send remembers whose name signed it', () => {
  const s = loaded(initialState(), { cards: [card('a')], quietCount: 0 })
  const [sending] = armExpired(tap(s)[0])
  assert.match(sendResult(sending, true, '', 'Alfredo').message, /Sent to Ops\n— Alfredo/)
})
