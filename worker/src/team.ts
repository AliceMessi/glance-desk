// Teams: several people with glasses watching the same Telegram group.
// Replies go out through the bot, signed with the name of who approved them,
// and a thread taken on one pair of glasses is hidden from the others for CLAIM_MS.

/** How long a thread stays with the teammate who last acted on it. */
export const CLAIM_MS = 2 * 60_000

const TG_MAX = 4096

export function firstName(name: string): string {
  const word = name.replace(/\(demo\)/i, '').trim().split(/\s+/)[0]
  return word || 'Team'
}

/** The bot sends the reply; the signature tells the client which person approved it. */
export function signReply(text: string, approver: string): string {
  const sig = `\n— ${firstName(approver)}`
  return text.slice(0, TG_MAX - sig.length) + sig
}

function list(names: string[]): string {
  const n = names.map(firstName)
  return n.length < 2 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`
}

export function watchMessage(members: string[]): string {
  if (members.length < 2) {
    return `Glance Desk is watching this chat for ${list(members)}. Replies approved on the glasses are sent by this bot `
      + 'and signed with the name of the person who approved them. /unwatch to stop.'
  }
  return `Glance Desk is watching this chat for ${list(members)}. When one of them takes a thread on the glasses, `
    + 'it is hidden from the others, so you get one answer, signed with the name of who sent it. /unwatch to stop.'
}

export function unwatchMessage(leaving: string, remaining: string[]): string {
  if (remaining.length) return `${firstName(leaving)} stopped watching this chat. ${list(remaining)} still ${remaining.length > 1 ? 'watch' : 'watches'} it.`
  return 'Stopped watching this chat. Stored messages deleted.'
}

export interface ReplyTarget {
  /** Our chat key: the Telegram group id, or `biz:<connection>:<chat>` for a Telegram Business chat. */
  chatId: string
  /** Set for Telegram Business chats: the bot then answers as the person, from their own account. */
  businessConnectionId: string | null
}

/**
 * The sendMessage body for a reply approved on the glasses.
 * Groups: the bot posts it, signed with the approver's first name. Business chats: Telegram sends it from the
 * person's own account, so it carries no signature (the client already sees who wrote it).
 */
export function outgoing(target: ReplyTarget, text: string, approver: string, replyTo?: number): Record<string, unknown> {
  const thread = replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}
  if (target.businessConnectionId) {
    return { chat_id: target.chatId.split(':')[2], text: text.slice(0, TG_MAX), business_connection_id: target.businessConnectionId, ...thread }
  }
  return { chat_id: target.chatId, text: signReply(text, approver), ...thread }
}
