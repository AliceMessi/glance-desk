import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUpdate, displayName, parseTestArgs } from '../worker/src/telegram.ts'

const from = { id: 42, is_bot: false, first_name: 'Marco', last_name: 'Rossi', username: 'mrossi' }

test('group text becomes a group message', () => {
  const u = parseUpdate({
    update_id: 1,
    message: { message_id: 7, date: 1700000000, chat: { id: -1001, type: 'supergroup', title: 'Ops' }, from, text: 'A che ora?' },
  })
  assert.deepEqual(u, {
    kind: 'group_message', chatId: '-1001', chatTitle: 'Ops', messageId: 7, fromId: '42', fromName: 'Marco Rossi',
    text: 'A che ora?', at: 1700000000000,
  })
})

test('captions count as text, other media is ignored', () => {
  const u = parseUpdate({ update_id: 2, message: { message_id: 8, date: 1, chat: { id: -1, type: 'group', title: 'G' }, from, caption: 'Foto del pallet' } })
  assert.equal(u?.kind, 'group_message')
  assert.equal(parseUpdate({ update_id: 3, message: { message_id: 9, date: 1, chat: { id: -1, type: 'group', title: 'G' }, from, sticker: {} } }), null)
})

test('commands are parsed with the bot username stripped', () => {
  const u = parseUpdate({ update_id: 4, message: { message_id: 1, date: 1, chat: { id: -5, type: 'group', title: 'G' }, from, text: '/watch@GlanceDeskBot now' } })
  assert.deepEqual(u, { kind: 'command', command: 'watch', args: 'now', chatId: '-5', chatTitle: 'G', chatType: 'group', fromId: '42', fromName: 'Marco Rossi', messageId: 1, at: 1000 })
  const p = parseUpdate({ update_id: 5, message: { message_id: 1, date: 1, chat: { id: 42, type: 'private' }, from, text: '/start' } })
  assert.equal(p?.kind, 'command')
  assert.equal(p && 'chatType' in p ? p.chatType : '', 'private')
})

test('messages from bots, edits without message and channel posts are ignored', () => {
  assert.equal(parseUpdate({ update_id: 6, message: { message_id: 1, date: 1, chat: { id: -1, type: 'group', title: 'G' }, from: { ...from, is_bot: true }, text: 'hi' } }), null)
  assert.equal(parseUpdate({ update_id: 7, edited_message: {} }), null)
  assert.equal(parseUpdate(null), null)
  assert.equal(parseUpdate({ update_id: 8, message: { message_id: 1, date: 1, chat: { id: 9, type: 'private' }, from, text: 'hello' } }), null)
})

test('displayName falls back to username, then id', () => {
  assert.equal(displayName({ id: 1, first_name: 'Ann' }), 'Ann')
  assert.equal(displayName({ id: 1, username: 'ann' }), '@ann')
  assert.equal(displayName({ id: 1 }), 'user 1')
})

test('parseTestArgs splits "Name: text" and defaults the name', () => {
  assert.deepEqual(parseTestArgs('Marco: Il corriere passa domani?'), { name: 'Marco', text: 'Il corriere passa domani?' })
  assert.deepEqual(parseTestArgs('Just a question?'), { name: 'Test', text: 'Just a question?' })
  assert.equal(parseTestArgs('   '), null)
  assert.deepEqual(parseTestArgs('https://x.y: z'), { name: 'Test', text: 'https://x.y: z' })
})
