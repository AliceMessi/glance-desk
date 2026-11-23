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
  | { kind: 'command'; command: string; args: string; chatId: string; chatTitle: string; chatType: string; fromId: string; fromName: string }

export function displayName(u: TgUser): string {
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
  if (full) return full
  if (u.username) return `@${u.username}`
  return `user ${u.id}`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseUpdate(update: any): Parsed | null {
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
    return { kind: 'command', command: cmd[1].toLowerCase(), args: (cmd[2] ?? '').trim(), chatId, chatTitle, chatType, fromId, fromName }
  }
  if (chatType !== 'group' && chatType !== 'supergroup') return null
  return { kind: 'group_message', chatId, chatTitle, messageId: Number(m.message_id), fromId, fromName, text, at: Number(m.date) * 1000 }
}

export async function tgCall(token: string, method: string, body: Record<string, unknown>): Promise<{ ok: boolean; description?: string; result?: unknown }> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    return (await res.json()) as { ok: boolean; description?: string }
  } catch {
    return { ok: false, description: `HTTP ${res.status}` }
  }
}

export function sendMessage(token: string, chatId: string, text: string, replyTo?: number) {
  return tgCall(token, 'sendMessage', {
    chat_id: chatId,
    text,
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  })
}
