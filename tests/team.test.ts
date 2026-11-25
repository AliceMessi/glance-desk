import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstName, signReply, watchMessage, unwatchMessage, outgoing, CLAIM_MS } from '../worker/src/team.ts'

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

test('a group reply goes out from the bot, signed, threaded to the message', () => {
  assert.deepEqual(outgoing({ chatId: '-1001', businessConnectionId: null }, 'Ok, alle 9.', 'Alfredo de Candia', 12), {
    chat_id: '-1001', text: 'Ok, alle 9.\n— Alfredo', reply_parameters: { message_id: 12, allow_sending_without_reply: true },
  })
})

test('a business-chat reply goes out as the person, unsigned, through their business connection', () => {
  assert.deepEqual(outgoing({ chatId: 'biz:BC1:555', businessConnectionId: 'BC1' }, 'Sì, 5% va bene.', 'Alfredo', 70), {
    chat_id: '555', text: 'Sì, 5% va bene.', business_connection_id: 'BC1',
    reply_parameters: { message_id: 70, allow_sending_without_reply: true },
  })
})
