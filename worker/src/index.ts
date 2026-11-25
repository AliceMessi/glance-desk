// Glance Desk Worker: Telegram webhook + API for the Even G2 app.
// Cloudflare Workers free tier: D1 for state, Workers AI (Whisper) for speech-to-text,
// OpenRouter free models for triage and drafts, with a heuristic fallback.

import {
  threadsFrom, quickTriage, buildTriageMessages, parseTriage, buildRewriteMessages, parseRewrite, guardDrafts,
  buildDigestMessages, digestFallback, type StoredMessage, type Thread, type Triage, type ChatMessage,
} from './triage.ts'
import { parseUpdate, sendMessage, tgCall, parseTestArgs, TG_API } from './telegram.ts'
import { DEMO_CHATS, DEMO_TEAMMATE_CHAT } from './demo.ts'
import { CLAIM_MS, firstName, watchMessage, unwatchMessage, outgoing } from './team.ts'

interface D1Result<T> { results: T[] }
interface D1Stmt {
  bind(...v: unknown[]): D1Stmt
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  run(): Promise<{ meta?: { changes?: number } }>
}
interface D1 { prepare(sql: string): D1Stmt; batch(s: D1Stmt[]): Promise<unknown> }
interface Ai { run(model: string, input: Record<string, unknown>): Promise<{ text?: string; response?: unknown }> }

export interface Env {
  DB: D1
  AI?: Ai
  TG_TOKEN?: string
  TG_WEBHOOK_SECRET?: string
  OPENROUTER_KEY?: string
  ADMIN_SECRET?: string
  MODELS?: string
  LLM_DAILY_CAP?: string
  /** Workers AI text model used when OpenRouter is unavailable or over its free quota. */
  FALLBACK_MODEL?: string
  /** Telegram Bot API base URL; only tests change it (to a local mock). */
  TG_API?: string
}

interface User { id: number; tg_user_id: string; name: string }

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
}
const DAY = 86_400_000
const RETENTION = 7 * DAY

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...CORS } })
}
const err = (status: number, message: string) => json({ error: message }, status)

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000
  return n.toString().padStart(6, '0')
}

/** Fixed-window counter; returns false once `limit` is reached inside the window. */
async function bump(env: Env, key: string, limit: number, windowMs = DAY): Promise<boolean> {
  const now = Date.now()
  const row = await env.DB.prepare('SELECT n, expires_at FROM counters WHERE key = ?').bind(key).first<{ n: number; expires_at: number }>()
  if (row && row.expires_at > now) {
    if (row.n >= limit) return false
    await env.DB.prepare('UPDATE counters SET n = n + 1 WHERE key = ?').bind(key).run()
    return true
  }
  await env.DB.prepare('INSERT OR REPLACE INTO counters (key, n, expires_at) VALUES (?, 1, ?)').bind(key, now + windowMs).run()
  return true
}

async function authUser(env: Env, req: Request): Promise<User | null> {
  const token = req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/)?.[1]
  if (!token) return null
  const hash = await sha256(token)
  const user = await env.DB.prepare(
    'SELECT u.id, u.tg_user_id, u.name FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?',
  ).bind(hash).first<User>()
  if (user) await env.DB.prepare('UPDATE devices SET last_seen = ? WHERE token_hash = ?').bind(Date.now(), hash).run()
  return user
}

async function issueDevice(env: Env, userId: number): Promise<string> {
  const token = randomToken()
  const now = Date.now()
  await env.DB.prepare('INSERT INTO devices (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), userId, now, now).run()
  return token
}

// ---------- LLM ----------

async function llm(env: Env, messages: ChatMessage[], maxTokens: number): Promise<string | null> {
  return (await openRouter(env, messages, maxTokens)) ?? (await workersAi(env, messages, maxTokens))
}

async function openRouter(env: Env, messages: ChatMessage[], maxTokens: number): Promise<string | null> {
  if (!env.OPENROUTER_KEY) return null
  const cap = Number(env.LLM_DAILY_CAP ?? '45')
  if (!(await bump(env, `llm:${new Date().toISOString().slice(0, 10)}`, cap))) return null
  const models = (env.MODELS ?? 'google/gemma-4-31b-it:free,nvidia/nemotron-3.5-super-vl:free,openrouter/free')
    .split(',').map(s => s.trim()).filter(Boolean)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 40_000)
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        authorization: `Bearer ${env.OPENROUTER_KEY}`,
        'content-type': 'application/json',
        'x-title': 'Glance Desk',
      },
      // Reasoning off: the free Nemotron models otherwise spend the budget (and ~20 s) thinking.
      body: JSON.stringify({ model: models[0], models, messages, max_tokens: maxTokens, temperature: 0.3, reasoning: { enabled: false } }),
    })
    if (!res.ok) {
      console.log('openrouter', res.status, (await res.text()).slice(0, 200))
      return null
    }
    const data = (await res.json()) as { model?: string; choices?: { message?: { content?: string } }[] }
    const content = data.choices?.[0]?.message?.content || null
    console.log('openrouter ok', data.model, content ? content.length : 0)
    return content
  } catch (e) {
    console.log('openrouter error', (e as Error).name)
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function workersAi(env: Env, messages: ChatMessage[], maxTokens: number): Promise<string | null> {
  if (!env.AI || !env.FALLBACK_MODEL) return null
  if (!(await bump(env, `wai:${new Date().toISOString().slice(0, 10)}`, 300))) return null
  try {
    const out = await env.AI.run(env.FALLBACK_MODEL, { messages, max_tokens: maxTokens, temperature: 0.3 })
    const r = out.response
    if (typeof r === 'string') return r || null
    return r ? JSON.stringify(r) : null
  } catch {
    return null
  }
}

async function triageThreads(env: Env, threads: Thread[], ownerName: string): Promise<Map<string, Triage>> {
  // OpenRouter first; threads it skipped or garbled go to Workers AI; whatever is still missing gets the heuristic.
  const got = new Map<string, Triage>()
  const tryWith = async (call: typeof openRouter, todo: Thread[]) => {
    if (!todo.length) return
    const text = await call(env, buildTriageMessages(todo, ownerName), 1400)
    if (!text) return
    for (const [chat, t] of parseTriage(text, todo.map(t => t.chatId))) {
      const { blocked, ...guarded } = guardDrafts(t, todo.find(x => x.chatId === chat)!)
      if (blocked) console.log('drafts blocked', blocked)
      got.set(chat, guarded)
    }
  }
  await tryWith(openRouter, threads)
  await tryWith(workersAi, threads.filter(t => !got.has(t.chatId)))
  for (const t of threads) if (!got.has(t.chatId)) got.set(t.chatId, quickTriage(t))
  return got
}

// ---------- queue ----------

interface CardRow {
  id: string; chat_id: string; title: string; category: string; urgency: number; summary: string; snippet: string
  from_name: string; drafts: string; source: string; at: number; later_at: number
}

async function refreshCards(env: Env, user: User): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT m.id, m.chat_id, c.title, m.message_id, m.from_name, m.text, m.at FROM messages m
     JOIN chats c ON c.chat_id = m.chat_id JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
     WHERE m.triaged = 0 ORDER BY m.at LIMIT 200`,
  ).bind(user.id).all<{ id: number; chat_id: string; title: string; message_id: number; from_name: string; text: string; at: number }>()
  if (!rows.results.length) return
  const messages: StoredMessage[] = rows.results.map(r => ({
    id: r.id, chatId: r.chat_id, chatTitle: r.title, messageId: r.message_id, fromName: r.from_name, text: r.text, at: r.at,
  }))
  const threads = await lockThreads(env, threadsFrom(messages).slice(0, 6))
  if (!threads.length) return
  try {
    await triageAndStore(env, user, threads)
  } finally {
    await env.DB.batch(threads.map(t => env.DB.prepare('DELETE FROM counters WHERE key = ? AND expires_at = ?').bind(`triage-lock:${t.chatId}`, lockUntil(t))))
  }
}

/**
 * Teammates share a chat's cards and may open their queues at the same moment. Each chat is locked while it is
 * triaged, and a thread is kept only if its messages are still untriaged once the lock is ours, so a thread is
 * triaged once and the card someone is looking at is never replaced by a duplicate.
 */
const LOCK_MS = 5 * 60_000 // longer than any triage run (OpenRouter times out at 40 s, then Workers AI, then the heuristic)
const lockExpiry = new WeakMap<Thread, number>()
const lockUntil = (t: Thread) => lockExpiry.get(t) ?? 0

async function lockThreads(env: Env, threads: Thread[]): Promise<Thread[]> {
  const now = Date.now()
  const mine: Thread[] = []
  for (const t of threads) {
    const key = `triage-lock:${t.chatId}`
    const got = await env.DB.prepare(
      `INSERT INTO counters (key, n, expires_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET n = 1, expires_at = excluded.expires_at WHERE counters.expires_at <= ?`,
    ).bind(key, now + LOCK_MS, now).run()
    if (!got.meta?.changes) continue
    const ids = t.messageIds
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE triaged = 0 AND id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids).first<{ n: number }>()
    if (left?.n === ids.length) {
      lockExpiry.set(t, now + LOCK_MS)
      mine.push(t)
    } else {
      await env.DB.prepare('DELETE FROM counters WHERE key = ? AND expires_at = ?').bind(key, now + LOCK_MS).run()
    }
  }
  return mine
}

async function triageAndStore(env: Env, user: User, threads: Thread[]): Promise<void> {
  // Cards are shared by everyone watching the chat, so drafts are written for the team, not just the caller.
  const team = await env.DB.prepare(
    `SELECT DISTINCT u.name FROM chat_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = ?)`,
  ).bind(user.id).all<{ name: string }>()
  const names = team.results.map(r => r.name)
  const results = await triageThreads(env, threads, names.length > 1 ? names.join(' / ') : user.name)
  const now = Date.now()
  const stmts: D1Stmt[] = []
  for (const t of threads) {
    const r = results.get(t.chatId)!
    const last = t.messages[t.messages.length - 1]
    stmts.push(env.DB.prepare("UPDATE cards SET status = 'replaced', updated_at = ? WHERE chat_id = ? AND status = 'open'").bind(now, t.chatId))
    stmts.push(env.DB.prepare(
      `INSERT INTO cards (id, user_id, chat_id, category, urgency, summary, snippet, from_name, drafts, source, reply_to, at, status, later_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?)`,
    ).bind(crypto.randomUUID(), user.id, t.chatId, r.category, r.urgency, r.summary, last.text.slice(0, 300), t.lastFrom,
      JSON.stringify(r.drafts), r.source, t.replyTo, t.at, now))
    const ids = t.messageIds
    stmts.push(env.DB.prepare(`UPDATE messages SET triaged = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids))
  }
  await env.DB.batch(stmts)
}

/** How long a send may stay in flight before the card is given back (the Worker died, or Telegram never answered). */
const SEND_STUCK_MS = 60_000

async function queue(env: Env, user: User) {
  // A send that never finished: the reply may or may not have reached Telegram, so the card comes back flagged
  // instead of disappearing for the whole team. If newer messages already made a fresh card, the old one is dropped.
  await env.DB.prepare(
    `UPDATE cards SET handled_by = NULL, updated_at = ?,
       status = CASE WHEN chat_id IN (SELECT chat_id FROM cards WHERE status = 'open') THEN 'replaced' ELSE 'open' END,
       summary = 'Check: may be sent · ' || summary
     WHERE status = 'sending' AND updated_at < ?`,
  ).bind(Date.now(), Date.now() - SEND_STUCK_MS).run()
  await refreshCards(env, user)
  const rows = await env.DB.prepare(
    `SELECT k.*, c.title, cl.user_id AS claim_user, cu.name AS claim_name FROM cards k
     JOIN chats c ON c.chat_id = k.chat_id
     JOIN chat_members cm ON cm.chat_id = k.chat_id AND cm.user_id = ?
     LEFT JOIN claims cl ON cl.chat_id = k.chat_id AND cl.expires_at > ?
     LEFT JOIN users cu ON cu.id = cl.user_id
     WHERE k.status = 'open'`,
  ).bind(user.id, Date.now()).all<CardRow & { claim_user: number | null; claim_name: string | null }>()
  const heldByOther = (r: { claim_user: number | null }) => r.claim_user !== null && r.claim_user !== user.id
  const needs = rows.results
    .filter(r => r.category === 'needs_you' && !heldByOther(r))
    .sort((a, b) => a.later_at - b.later_at || b.urgency - a.urgency || b.at - a.at)
  const taken = rows.results
    .filter(r => r.category === 'needs_you' && heldByOther(r))
    .map(r => ({ chatTitle: r.title, by: firstName(r.claim_name ?? '') }))
  return {
    taken,
    cards: needs.map(r => ({
      id: r.id, chatTitle: r.title, from: r.from_name, category: r.category, urgency: r.urgency, summary: r.summary,
      snippet: r.snippet, drafts: JSON.parse(r.drafts) as string[], source: r.source, at: r.at,
    })),
    quietCount: rows.results.filter(r => r.category !== 'needs_you').length,
  }
}

/** A card in a chat this user watches, in any status (so a teammate can be told who handled it). */
async function memberCard(env: Env, user: User, id: string) {
  return env.DB.prepare(
    `SELECT k.id, k.chat_id, k.reply_to, k.snippet, k.status, k.handled_by, c.is_demo, c.title, c.business_connection_id, h.name AS handled_name FROM cards k
     JOIN chats c ON c.chat_id = k.chat_id
     JOIN chat_members cm ON cm.chat_id = k.chat_id AND cm.user_id = ?
     LEFT JOIN users h ON h.id = k.handled_by
     WHERE k.id = ?`,
  ).bind(user.id, id).first<{
    id: string; chat_id: string; reply_to: number; snippet: string; status: string; is_demo: number; title: string
    business_connection_id: string | null; handled_by: number | null; handled_name: string | null
  }>()
}

/**
 * Take (or keep) the thread for CLAIM_MS. Atomic: the upsert only overwrites a claim that is ours or expired.
 * Returns the first name of the teammate holding it when it is not ours.
 */
async function acquire(env: Env, user: User, chatId: string): Promise<string | null> {
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO claims (chat_id, user_id, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at
     WHERE claims.user_id = excluded.user_id OR claims.expires_at <= ?`,
  ).bind(chatId, user.id, now + CLAIM_MS, now).run()
  const row = await env.DB.prepare('SELECT cl.user_id, u.name FROM claims cl JOIN users u ON u.id = cl.user_id WHERE cl.chat_id = ?')
    .bind(chatId).first<{ user_id: number; name: string }>()
  return !row || row.user_id === user.id ? null : firstName(row.name)
}

const release = (env: Env, user: User, chatId: string) =>
  env.DB.prepare('DELETE FROM claims WHERE chat_id = ? AND user_id = ?').bind(chatId, user.id)

/** The paired people watching a chat, in the order they joined. */
async function members(env: Env, chatId: string): Promise<{ id: number; tg_user_id: string; name: string }[]> {
  return (await env.DB.prepare(
    'SELECT u.id, u.tg_user_id, u.name FROM chat_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ? ORDER BY cm.created_at',
  ).bind(chatId).all<{ id: number; tg_user_id: string; name: string }>()).results
}

// ---------- Telegram webhook ----------

async function reply(env: Env, chatId: string, text: string) {
  if (env.TG_TOKEN) await sendMessage(env.TG_TOKEN, chatId, text, undefined, env.TG_API ?? TG_API)
}

async function onTelegram(env: Env, update: unknown): Promise<void> {
  const u = parseUpdate(update)
  // Debug trace without message text or names.
  const raw = (update as { message?: { chat?: { type?: string }; from?: { is_bot?: boolean } } } | null)?.message
  console.log('tg update', u ? (u.kind === 'command' ? `command:${u.command}:${u.chatType}` : u.kind) : `ignored:${raw?.chat?.type}:bot=${raw?.from?.is_bot}`)
  if (!u) return
  const now = Date.now()

  if (u.kind === 'business_connection') return onBusinessConnection(env, u)
  if (u.kind === 'business_message') {
    // A private chat between a connected person and their client. The chat is created on its first message,
    // only for an enabled connection of someone who paired the app.
    const conn = await env.DB.prepare('SELECT user_id FROM business_connections WHERE id = ?').bind(u.connectionId).first<{ user_id: number }>()
    if (!conn) return
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO chats (chat_id, user_id, title, is_demo, created_at, business_connection_id) VALUES (?, ?, ?, 0, ?, ?)')
        .bind(u.chatId, conn.user_id, u.chatTitle, now, u.connectionId),
      env.DB.prepare('INSERT OR IGNORE INTO chat_members (chat_id, user_id, created_at) VALUES (?, ?, ?)').bind(u.chatId, conn.user_id, now),
    ])
  }

  if (u.kind === 'command') {
    if (u.chatType === 'private' && (u.command === 'start' || u.command === 'pair')) {
      await env.DB.prepare('INSERT INTO users (tg_user_id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(tg_user_id) DO UPDATE SET name = excluded.name')
        .bind(u.fromId, u.fromName, now).run()
      const user = await env.DB.prepare('SELECT id FROM users WHERE tg_user_id = ?').bind(u.fromId).first<{ id: number }>()
      const code = randomCode()
      await env.DB.prepare('DELETE FROM pair_codes WHERE user_id = ? OR expires_at < ?').bind(user!.id, now).run()
      await env.DB.prepare('INSERT OR REPLACE INTO pair_codes (code, user_id, expires_at) VALUES (?, ?, ?)').bind(code, user!.id, now + 10 * 60_000).run()
      await reply(env, u.chatId, [
        `Your Glance Desk pairing code: ${code}`,
        'Type it in the Glance Desk app on your phone (valid 10 minutes).',
        'Then add me to a work group and send /watch there.',
      ].join('\n'))
      return
    }
    if (u.chatType === 'group' || u.chatType === 'supergroup') {
      const owner = await env.DB.prepare(
        'SELECT u.id, u.name FROM users u WHERE u.tg_user_id = ? AND EXISTS (SELECT 1 FROM devices d WHERE d.user_id = u.id)',
      ).bind(u.fromId).first<{ id: number; name: string }>()
      if (u.command === 'watch') {
        if (!owner) return reply(env, u.chatId, 'Pair the Glance Desk app first: send /start to me in a private chat.')
        // Only group admins can add Glance Desk, so a client in the group can't join the team, read its drafts
        // or close cards with their own messages.
        if (!env.TG_TOKEN) return
        const member = await tgCall(env.TG_TOKEN, 'getChatMember', { chat_id: u.chatId, user_id: Number(u.fromId) }, env.TG_API ?? TG_API)
        const status = (member.result as { status?: string } | undefined)?.status
        if (!member.ok || (status !== 'creator' && status !== 'administrator')) {
          return reply(env, u.chatId, 'Only group admins can add Glance Desk to this chat with /watch.')
        }
        // The first person to /watch creates the chat; teammates who /watch later join it and share its cards.
        await env.DB.batch([
          env.DB.prepare('INSERT OR IGNORE INTO chats (chat_id, user_id, title, is_demo, created_at) VALUES (?, ?, ?, 0, ?)')
            .bind(u.chatId, owner.id, u.chatTitle, now),
          env.DB.prepare('INSERT OR IGNORE INTO chat_members (chat_id, user_id, created_at) VALUES (?, ?, ?)').bind(u.chatId, owner.id, now),
        ])
        return reply(env, u.chatId, watchMessage((await members(env, u.chatId)).map(m => m.name)))
      }
      if (u.command === 'test' && owner) {
        const watched = await env.DB.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').bind(u.chatId, owner.id).first()
        const parsed = parseTestArgs(u.args)
        if (!watched) return reply(env, u.chatId, 'Send /watch here first.')
        if (!parsed) return reply(env, u.chatId, 'Usage: /test Marco: Can the courier come tomorrow at 9?')
        await env.DB.prepare('INSERT INTO messages (chat_id, message_id, from_name, text, at) VALUES (?, ?, ?, ?, ?)')
          .bind(u.chatId, u.messageId, parsed.name, parsed.text.slice(0, 2000), u.at).run()
        return
      }
      if (u.command === 'unwatch' && owner) {
        const was = await members(env, u.chatId)
        if (!was.some(m => m.id === owner.id)) return
        const remaining = was.filter(m => m.id !== owner.id)
        if (remaining.length) {
          // Teammates still watch it: only this person leaves, and their claim is released.
          await env.DB.batch([
            env.DB.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').bind(u.chatId, owner.id),
            env.DB.prepare('DELETE FROM claims WHERE chat_id = ? AND user_id = ?').bind(u.chatId, owner.id),
          ])
        } else {
          await env.DB.batch([
            env.DB.prepare('DELETE FROM chats WHERE chat_id = ?').bind(u.chatId),
            env.DB.prepare('DELETE FROM chat_members WHERE chat_id = ?').bind(u.chatId),
            env.DB.prepare('DELETE FROM claims WHERE chat_id = ?').bind(u.chatId),
            env.DB.prepare('DELETE FROM messages WHERE chat_id = ?').bind(u.chatId),
            env.DB.prepare("UPDATE cards SET status = 'closed', updated_at = ? WHERE chat_id = ? AND status = 'open'").bind(now, u.chatId),
          ])
        }
        return reply(env, u.chatId, unwatchMessage(owner.name, remaining.map(m => m.name)))
      }
    }
    return
  }

  // Group message in a watched chat, or a message in a connected business chat.
  const team = await members(env, u.chatId)
  if (!team.length) return
  const member = team.find(m => m.tg_user_id === u.fromId)
  if (member) {
    // Someone on the team answered from the phone: the thread is handled, for everyone.
    await env.DB.batch([
      env.DB.prepare("UPDATE cards SET status = 'done', handled_by = ?, updated_at = ? WHERE chat_id = ? AND status = 'open'").bind(member.id, now, u.chatId),
      env.DB.prepare('UPDATE messages SET triaged = 1 WHERE chat_id = ? AND triaged = 0').bind(u.chatId),
      env.DB.prepare('DELETE FROM claims WHERE chat_id = ?').bind(u.chatId),
    ])
    return
  }
  await env.DB.prepare('INSERT INTO messages (chat_id, message_id, from_name, text, at) VALUES (?, ?, ?, ?, ?)')
    .bind(u.chatId, u.messageId, u.fromName, u.text.slice(0, 2000), u.at).run()
  await env.DB.prepare('UPDATE chats SET title = ? WHERE chat_id = ?').bind(u.chatTitle, u.chatId).run()
}

// ---------- Telegram Business ----------

/** Store the connection for a paired person; disabling it deletes its chats, like /unwatch. */
async function onBusinessConnection(env: Env, u: { connectionId: string; ownerId: string; canReply: boolean; enabled: boolean }): Promise<void> {
  const owner = await env.DB.prepare(
    'SELECT u.id FROM users u WHERE u.tg_user_id = ? AND EXISTS (SELECT 1 FROM devices d WHERE d.user_id = u.id)',
  ).bind(u.ownerId).first<{ id: number }>()
  const prefix = `biz:${u.connectionId}:`
  if (!owner || !u.enabled) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM business_connections WHERE id = ?').bind(u.connectionId),
      env.DB.prepare('DELETE FROM messages WHERE chat_id IN (SELECT chat_id FROM chats WHERE business_connection_id = ?)').bind(u.connectionId),
      env.DB.prepare("UPDATE cards SET status = 'closed', updated_at = ? WHERE status = 'open' AND substr(chat_id, 1, ?) = ?").bind(Date.now(), prefix.length, prefix),
      env.DB.prepare('DELETE FROM chat_members WHERE chat_id IN (SELECT chat_id FROM chats WHERE business_connection_id = ?)').bind(u.connectionId),
      env.DB.prepare('DELETE FROM claims WHERE chat_id IN (SELECT chat_id FROM chats WHERE business_connection_id = ?)').bind(u.connectionId),
      env.DB.prepare('DELETE FROM chats WHERE business_connection_id = ?').bind(u.connectionId),
    ])
    return
  }
  await env.DB.prepare(
    `INSERT INTO business_connections (id, user_id, can_reply, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, can_reply = excluded.can_reply`,
  ).bind(u.connectionId, owner.id, u.canReply ? 1 : 0, Date.now()).run()
}

// ---------- demo ----------

/** A demo team: Alex (the wearer) and Nina, a teammate who is already answering one thread. */
async function createDemo(env: Env): Promise<{ token: string; teammateToken: string }> {
  const now = Date.now()
  const tag = `demo-${crypto.randomUUID()}`
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (tg_user_id, name, created_at) VALUES (?, ?, ?)').bind(tag, 'Alex (demo)', now),
    env.DB.prepare('INSERT INTO users (tg_user_id, name, created_at) VALUES (?, ?, ?)').bind(`${tag}-nina`, 'Nina (demo)', now),
  ])
  const user = (await env.DB.prepare('SELECT id FROM users WHERE tg_user_id = ?').bind(tag).first<{ id: number }>())!
  const mate = (await env.DB.prepare('SELECT id FROM users WHERE tg_user_id = ?').bind(`${tag}-nina`).first<{ id: number }>())!
  const stmts: D1Stmt[] = []
  DEMO_CHATS.forEach((chat, i) => {
    const chatId = `${tag}:${i}`
    stmts.push(env.DB.prepare('INSERT INTO chats (chat_id, user_id, title, is_demo, created_at) VALUES (?, ?, ?, 1, ?)').bind(chatId, user.id, chat.title, now))
    stmts.push(env.DB.prepare('INSERT INTO chat_members (chat_id, user_id, created_at) VALUES (?, ?, ?), (?, ?, ?)')
      .bind(chatId, user.id, now, chatId, mate.id, now + 1))
    // Nina holds this thread for the life of the demo, so the wearer sees "Nina is answering".
    if (chat.title === DEMO_TEAMMATE_CHAT) {
      stmts.push(env.DB.prepare('INSERT INTO claims (chat_id, user_id, expires_at) VALUES (?, ?, ?)').bind(chatId, mate.id, now + DAY))
    }
    chat.messages.forEach((m, j) => {
      stmts.push(env.DB.prepare('INSERT INTO messages (chat_id, message_id, from_name, text, at) VALUES (?, ?, ?, ?, ?)')
        .bind(chatId, j + 1, m.from, m.text, now - (chat.messages.length - j) * 60_000 - i * 1000))
    })
  })
  await env.DB.batch(stmts)
  return { token: await issueDevice(env, user.id), teammateToken: await issueDevice(env, mate.id) }
}

// ---------- speech-to-text ----------

async function transcribe(env: Env, wavBase64: string): Promise<string> {
  if (!env.AI) throw new Error('Speech-to-text is not configured')
  const out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio: wavBase64 })
  return (out.text ?? '').trim()
}

// ---------- router ----------

async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  if (path === '/' && req.method === 'GET') {
    return new Response('Glance Desk API. Telegram work-chat triage for Even Realities G2.', { headers: { 'content-type': 'text/plain', ...CORS } })
  }

  if (path === '/tg/webhook' && req.method === 'POST') {
    if (!env.TG_WEBHOOK_SECRET || req.headers.get('x-telegram-bot-api-secret-token') !== env.TG_WEBHOOK_SECRET) return err(401, 'bad secret')
    await onTelegram(env, await req.json().catch(() => null))
    return json({ ok: true })
  }

  if (path === '/admin/webhook' && req.method === 'POST') {
    if (!env.ADMIN_SECRET || req.headers.get('authorization') !== `Bearer ${env.ADMIN_SECRET}`) return err(401, 'no')
    if (!env.TG_TOKEN || !env.TG_WEBHOOK_SECRET) return err(500, 'missing telegram secrets')
    const hook = await tgCall(env.TG_TOKEN, 'setWebhook', {
      url: `${url.origin}/tg/webhook`, secret_token: env.TG_WEBHOOK_SECRET, drop_pending_updates: true,
      allowed_updates: ['message', 'business_connection', 'business_message'],
    })
    const cmds = await tgCall(env.TG_TOKEN, 'setMyCommands', { commands: [
      { command: 'start', description: 'Get a pairing code for the Glance Desk app' },
      { command: 'watch', description: 'Triage this group on your glasses' },
      { command: 'unwatch', description: 'Stop watching this group and delete its data' },
      { command: 'test', description: 'Watchers only: simulate a message, e.g. /test Marco: ok for 9?' },
    ] })
    return json({ webhook: hook, commands: cmds })
  }

  const ip = req.headers.get('cf-connecting-ip') ?? 'local'

  if (path === '/api/pair' && req.method === 'POST') {
    if (!(await bump(env, `pair:${ip}`, 20))) return err(429, 'Too many attempts, try tomorrow')
    const body = (await req.json().catch(() => ({}))) as { code?: string }
    const code = String(body.code ?? '').replace(/\D/g, '')
    const row = await env.DB.prepare('SELECT user_id, expires_at FROM pair_codes WHERE code = ?').bind(code).first<{ user_id: number; expires_at: number }>()
    if (!row || row.expires_at < Date.now()) return err(400, 'Code not valid or expired. Send /start to the bot again.')
    await env.DB.prepare('DELETE FROM pair_codes WHERE code = ?').bind(code).run()
    return json({ token: await issueDevice(env, row.user_id) })
  }

  if (path === '/api/demo' && req.method === 'POST') {
    if (!(await bump(env, `demo:${ip}`, 30))) return err(429, 'Demo limit reached for today')
    return json(await createDemo(env))
  }

  if (!path.startsWith('/api/')) return err(404, 'not found')
  const user = await authUser(env, req)
  if (!user) return err(401, 'Not paired')

  if (path === '/api/queue' && req.method === 'GET') return json(await queue(env, user))

  if (path === '/api/digest' && req.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT c.title AS chatTitle, k.summary FROM cards k JOIN chats c ON c.chat_id = k.chat_id
       JOIN chat_members cm ON cm.chat_id = k.chat_id AND cm.user_id = ?
       WHERE k.status = 'open' AND k.category != 'needs_you' ORDER BY k.urgency DESC, k.at DESC LIMIT 20`,
    ).bind(user.id).all<{ chatTitle: string; summary: string }>()
    if (!rows.results.length) return json({ lines: ['Nothing quiet to report.'] })
    const text = await llm(env, buildDigestMessages(rows.results), 300)
    const lines = text
      ? text.split('\n').map(l => l.replace(/^[-*•\d.\s]+/, '').trim()).filter(Boolean).slice(0, 5)
      : []
    return json({ lines: lines.length ? lines : digestFallback(rows.results) })
  }

  const m = path.match(/^\/api\/cards\/([\w-]+)\/(send|later|done|dictate|claim)$/)
  if (m && req.method === 'POST') {
    const card = await memberCard(env, user, m[1])
    if (!card) return err(404, 'Card not found or already handled')
    if (card.status === 'sent' || card.status === 'done' || card.status === 'sending') {
      // Compare ids, not names: two teammates can share a first name.
      const other = card.handled_by !== null && card.handled_by !== user.id
      const who = other && card.handled_name ? firstName(card.handled_name) : ''
      const verb = card.status === 'done' ? 'already handled this' : card.status === 'sending' ? 'is answering' : 'already answered'
      return json({ error: who ? `${who} ${verb}` : 'Already handled', by: who }, 409)
    }
    if (card.status !== 'open') return err(404, 'Card not found or already handled')
    // Every action on a card first takes the thread, so two teammates never answer the same client.
    const holder = await acquire(env, user, card.chat_id)
    if (holder) return json({ error: `${holder} is answering ${card.title}`, by: holder }, 409)
    const now = Date.now()
    const body = (await req.json().catch(() => ({}))) as { text?: string; draft?: string; audio?: string }

    if (m[2] === 'claim') return json({ ok: true, until: now + CLAIM_MS })
    if (m[2] === 'later') {
      await env.DB.batch([
        env.DB.prepare('UPDATE cards SET later_at = ?, updated_at = ? WHERE id = ?').bind(now, now, card.id),
        release(env, user, card.chat_id),
      ])
      return json({ ok: true })
    }
    if (m[2] === 'done') {
      await env.DB.batch([
        env.DB.prepare("UPDATE cards SET status = 'done', handled_by = ?, updated_at = ? WHERE id = ?").bind(user.id, now, card.id),
        release(env, user, card.chat_id),
      ])
      return json({ ok: true })
    }
    if (m[2] === 'send') {
      const text = String(body.text ?? '').trim().slice(0, 1000)
      if (!text) return err(400, 'Empty reply')
      if (!card.is_demo && !env.TG_TOKEN) return err(500, 'Bot not configured')
      // Mark the card before talking to Telegram: only one request can win this update.
      const won = await env.DB.prepare("UPDATE cards SET status = 'sending', handled_by = ?, updated_at = ? WHERE id = ? AND status = 'open'")
        .bind(user.id, now, card.id).run()
      if (!won.meta?.changes) {
        const by = await env.DB.prepare('SELECT u.name FROM cards k JOIN users u ON u.id = k.handled_by WHERE k.id = ?').bind(card.id).first<{ name: string }>()
        const who = by ? firstName(by.name) : ''
        return json({ error: who ? `${who} is answering ${card.title}` : 'Already being answered', by: who }, 409)
      }
      if (!card.is_demo) {
        const target = { chatId: card.chat_id, businessConnectionId: card.business_connection_id }
        const res = await tgCall(env.TG_TOKEN!, 'sendMessage', outgoing(target, text, user.name, card.reply_to), env.TG_API ?? TG_API)
        if (!res.ok) {
          // Give the card back, unless newer messages already produced a fresh card for this chat.
          await env.DB.prepare(
            `UPDATE cards SET handled_by = NULL,
               status = CASE WHEN chat_id IN (SELECT chat_id FROM cards WHERE status = 'open') THEN 'replaced' ELSE 'open' END
             WHERE id = ?`,
          ).bind(card.id).run()
          return err(502, `Telegram: ${res.description ?? 'error'}`)
        }
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE cards SET status = 'sent', updated_at = ? WHERE id = ?").bind(now, card.id),
        release(env, user, card.chat_id),
      ])
      return json({ ok: true, signedAs: firstName(user.name) })
    }
    // dictate
    if (!(await bump(env, `stt:${user.id}`, 60))) return err(429, 'Dictation limit reached for today')
    const audio = String(body.audio ?? '')
    if (!audio || audio.length > 1_400_000) return err(400, 'Audio missing or longer than 30 s')
    let spoken: string
    try {
      spoken = await transcribe(env, audio)
    } catch (e) {
      return err(502, (e as Error).message)
    }
    if (!spoken) return err(422, 'Did not catch that')
    const draft = String(body.draft ?? '')
    const rewritten = await llm(env, buildRewriteMessages(card.snippet, draft, spoken, user.name), 120)
    const text = (rewritten && parseRewrite(rewritten)) || spoken.slice(0, 140)
    return json({ draft: text, heard: spoken })
  }

  return err(404, 'not found')
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await handle(req, env)
    } catch (e) {
      console.error(e)
      return err(500, 'Server error')
    }
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const cutoff = Date.now() - RETENTION
    await env.DB.batch([
      env.DB.prepare('DELETE FROM messages WHERE at < ?').bind(cutoff),
      env.DB.prepare("DELETE FROM cards WHERE updated_at < ? AND status != 'open'").bind(cutoff),
      env.DB.prepare('DELETE FROM pair_codes WHERE expires_at < ?').bind(Date.now()),
      env.DB.prepare('DELETE FROM counters WHERE expires_at < ?').bind(Date.now()),
      env.DB.prepare("DELETE FROM devices WHERE last_seen < ? AND user_id IN (SELECT id FROM users WHERE tg_user_id LIKE 'demo-%')").bind(Date.now() - DAY),
      env.DB.prepare("DELETE FROM chats WHERE is_demo = 1 AND created_at < ?").bind(Date.now() - DAY),
      env.DB.prepare('DELETE FROM chat_members WHERE chat_id NOT IN (SELECT chat_id FROM chats)'),
      env.DB.prepare('DELETE FROM claims WHERE expires_at < ?').bind(Date.now()),
    ])
  },
}
