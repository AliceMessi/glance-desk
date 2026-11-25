// A stand-in for the Telegram Bot API, for tests/e2e.mjs. The local Worker reaches it through
// TG_API=http://127.0.0.1:8790 and TG_TOKEN=test-token in worker/.dev.vars.
// - getChatMember: "administrator" for the ids in `admins`, "member" for everyone else;
// - sendMessage: ok, unless the text contains FAIL (then Telegram refuses it);
// every call is recorded in `calls` so tests can check what the bot really sent.

import { createServer } from 'node:http'

export function startTelegramMock(port = 8790) {
  const calls = []
  const admins = new Set()
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const method = req.url.split('/').pop()
      const body = raw ? JSON.parse(raw) : {}
      calls.push({ method, body })
      let out = { ok: true, result: true }
      if (method === 'getChatMember') {
        out = { ok: true, result: { status: admins.has(Number(body.user_id)) ? 'administrator' : 'member' } }
      }
      if (method === 'sendMessage' && /FAIL/.test(body.text ?? '')) {
        out = { ok: false, description: 'Bad Request: mock refused' }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    })
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({
    calls,
    admins,
    sent: () => calls.filter(c => c.method === 'sendMessage').map(c => c.body),
    close: () => new Promise(r => server.close(r)),
  })))
}
