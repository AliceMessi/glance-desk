// Telegram Bot API: parse webhook updates and send replies.

export interface TgUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

export type Parsed =
  | { kind: 'group_message'; chatId: string; chatTitle: string; messageId: number; fromId: string; fromName: string; text: string; at: number }
  | { kind: 'command'; command: string; args: string; chatId: string; chatTitle: string; chatType: string; fromId: string; fromName: string; messageId: number; at: number }
  | { kind: 'business_connection'; connectionId: string; ownerId: string; ownerName: string; canReply: boolean; enabled: boolean }
  | {
    kind: 'business_message'; connectionId: string; chatId: string; tgChatId: string; chatTitle: string
    messageId: number; fromId: string; fromName: string; text: string; at: number
  }

export function displayName(u: TgUser): string {
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
  if (full) return full
  if (u.username) return `@${u.username}`
  return `user ${u.id}`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseUpdate(update: any): Parsed | null {
  const bc = update?.business_connection
  if (bc?.id && bc.user) {
    // Bot API 9: rights.can_reply; earlier versions: can_reply at the top level.
    const canReply = Boolean(bc.rights?.can_reply ?? bc.can_reply)
    return { kind: 'business_connection', connectionId: String(bc.id), ownerId: String(bc.user.id), ownerName: displayName(bc.user), canReply, enabled: Boolean(bc.is_enabled) }
  }
  const bm = update?.business_message
  if (bm) {
    const text: string | undefined = typeof bm.text === 'string' ? bm.text : typeof bm.caption === 'string' ? bm.caption : undefined
    if (!text || !bm.chat || !bm.from || !bm.business_connection_id) return null
    const conn = String(bm.business_connection_id)
    const tgChatId = String(bm.chat.id)
    return {
      kind: 'business_message', connectionId: conn, chatId: `biz:${conn}:${tgChatId}`, tgChatId,
      chatTitle: displayName(bm.chat), messageId: Number(bm.message_id), fromId: String(bm.from.id), fromName: displayName(bm.from),
      text, at: Number(bm.date) * 1000,
    }
  }
  const m = update?.message
  if (!m || !m.chat || !m.from || m.from.is_bot) return null
  const text: string | undefined = typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : undefined
  if (!text) return null
  const chatId = String(m.chat.id)
  const chatType = String(m.chat.type)
  const chatTitle = String(m.chat.title ?? displayName(m.from))
  const fromId = String(m.from.id)
  const fromName = displayName(m.from)

  const cmd = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i)
  if (cmd) {
    return {
      kind: 'command', command: cmd[1].toLowerCase(), args: (cmd[2] ?? '').trim(), chatId, chatTitle, chatType, fromId, fromName,
      messageId: Number(m.message_id), at: Number(m.date) * 1000,
    }
  }
  if (chatType !== 'group' && chatType !== 'supergroup') return null
  return { kind: 'group_message', chatId, chatTitle, messageId: Number(m.message_id), fromId, fromName, text, at: Number(m.date) * 1000 }
}

/**
 * `/test Name: text` lets a lone owner simulate a colleague's message in a watched group
 * (the owner's own messages close cards instead of creating them).
 */
export function parseTestArgs(args: string): { name: string; text: string } | null {
  const trimmed = args.trim()
  if (!trimmed) return null
  const m = trimmed.match(/^([\p{L}][\p{L} .'-]{0,30}):\s+([\s\S]+)$/u)
  return m ? { name: m[1].trim(), text: m[2].trim() } : { name: 'Test', text: trimmed }
}

export const TG_API = 'https://api.telegram.org'

/** Never throws: network errors and timeouts come back as { ok: false }, so callers can always undo their state. */
export async function tgCall(
  token: string, method: string, body: Record<string, unknown>, base = TG_API, timeoutMs = 15_000,
): Promise<{ ok: boolean; description?: string; result?: unknown }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}/bot${token}/${method}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    try {
      return (await res.json()) as { ok: boolean; description?: string }
    } catch {
      return { ok: false, description: `HTTP ${res.status}` }
    }
  } catch (e) {
    return { ok: false, description: (e as Error).name === 'AbortError' ? 'timed out' : 'network error' }
  } finally {
    clearTimeout(timer)
  }
}

export function sendMessage(token: string, chatId: string, text: string, replyTo?: number, base = TG_API) {
  return tgCall(token, 'sendMessage', {
    chat_id: chatId,
    text,
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  }, base)
}
