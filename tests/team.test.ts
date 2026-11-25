import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstName, signReply, watchMessage, unwatchMessage, CLAIM_MS } from '../worker/src/team.ts'

test('firstName keeps the first word and drops a "(demo)" tag', () => {
  assert.equal(firstName('Alfredo de Candia'), 'Alfredo')
  assert.equal(firstName('Nina (demo)'), 'Nina')
  assert.equal(firstName('@ops_lead'), '@ops_lead')
  assert.equal(firstName('   '), 'Team')
})

test('signReply signs the reply with the first name of who approved it', () => {
  assert.equal(signReply('Yes, roll back now please.', 'Alfredo de Candia'), 'Yes, roll back now please.\n— Alfredo')
})

test('signReply keeps the whole message within the Telegram limit', () => {
  const signed = signReply('x'.repeat(5000), 'Nina')
  assert.ok(signed.length <= 4096, String(signed.length))
  assert.ok(signed.endsWith('\n— Nina'))
})

test('watch message for one person says replies are signed', () => {
  const m = watchMessage(['Alfredo de Candia'])
  assert.match(m, /for Alfredo/)
  assert.match(m, /signed with the name/)
  assert.match(m, /\/unwatch/)
})

test('watch message for a team names everyone and explains who takes a thread', () => {
  const m = watchMessage(['Alfredo de Candia', 'Nina Rossi', 'Sam'])
  assert.match(m, /Alfredo, Nina and Sam/)
  assert.match(m, /takes a thread/)
  assert.match(m, /one answer/)
})

test('unwatch message deletes data only when nobody is left', () => {
  assert.match(unwatchMessage('Nina Rossi', ['Alfredo']), /Nina stopped watching.*Alfredo still/)
  assert.match(unwatchMessage('Alfredo', []), /deleted/)
})

test('a claim lasts two minutes', () => {
  assert.equal(CLAIM_MS, 120_000)
})
