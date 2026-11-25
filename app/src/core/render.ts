// Turns DeskState into the text of the five glasses containers.
// Pure: main.ts pushes the strings with textContainerUpgrade.

import { choicesFor, current, LATER, DONE, type DeskState } from './desk.ts'

export interface Box {
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  /** Uniform padding; single-line boxes use 2 so one text line fits without a scroll bar. */
  pad: number
  /** Text brightness 0-4. */
  brightness: number
  border: number
  capture: boolean
}

/** 576x288 canvas. The reply box captures input so swipes cycle drafts. */
export const LAYOUT = {
  header: { id: 1, name: 'header', x: 0, y: 0, w: 576, h: 38, pad: 2, brightness: 4, border: 0, capture: false },
  meta: { id: 2, name: 'meta', x: 0, y: 38, w: 576, h: 34, pad: 2, brightness: 2, border: 0, capture: false },
  body: { id: 3, name: 'body', x: 0, y: 72, w: 576, h: 106, pad: 2, brightness: 3, border: 0, capture: false },
  reply: { id: 4, name: 'reply', x: 0, y: 180, w: 576, h: 72, pad: 4, brightness: 4, border: 1, capture: true },
  footer: { id: 5, name: 'footer', x: 0, y: 254, w: 576, h: 34, pad: 2, brightness: 1, border: 0, capture: false },
} satisfies Record<string, Box>

export type Field = keyof typeof LAYOUT
export type Screen = Record<Field, string>

/** Rough per-container budgets: ~46 characters per line at the firmware font. */
export const LIMITS: Record<Field, number> = { header: 46, meta: 46, body: 180, reply: 120, footer: 52 }

const HINT_CARD = 'swipe ▲▼ choose · tap send · hold to dictate'

/**
 * Keep what the firmware font can draw: drop emoji, pictographs (incl. dingbats such as check marks)
 * and control chars. Our own UI glyphs stay inside the documented set: ● ○ ■ ▶ ▲ ▼ ·
 */
export function sanitize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, max - 3).join('') + '...'
}

export function urgencyBar(urgency: number): string {
  const n = Math.max(0, Math.min(3, Math.round(urgency)))
  return '●'.repeat(n) + '○'.repeat(3 - n)
}

function fit(s: Screen): Screen {
  const out = {} as Screen
  for (const key of Object.keys(LIMITS) as Field[]) out[key] = clip(sanitize(s[key]), LIMITS[key])
  return out
}

const LABEL = { needs_you: 'NEEDS YOU', fyi: 'FYI', noise: 'LOW' } as const

export function screen(s: DeskState): Screen {
  const blank: Screen = { header: 'GLANCE DESK', meta: '', body: '', reply: '', footer: '' }
  const card = current(s)

  switch (s.mode) {
    case 'loading':
      return fit({ ...blank, body: 'Loading your chats...' })
    case 'error':
      return fit({ ...blank, body: s.message || 'Something went wrong', reply: '▶ Tap to retry', footer: 'double tap to exit' })
    case 'empty':
      return fit({
        ...blank,
        header: 'GLANCE DESK',
        body: ['All clear. Nothing needs you.', ...takenLines(s), `${s.quietCount} quiet thread${s.quietCount === 1 ? '' : 's'} (FYI / low).`].join('\n'),
        reply: '▶ Tap for the 5-line digest',
        footer: s.message || 'menu: refresh',
      })
    case 'digest':
      return fit({ ...blank, header: 'DIGEST', body: s.digest.slice(0, 5).join('\n'), reply: '▶ Tap to go back', footer: '' })
    case 'sent':
      return fit({ ...blank, header: 'GLANCE DESK', body: s.message, reply: '', footer: '' })
    case 'thinking':
      return fit({ ...blank, body: card && s.cards.length ? cardBody(s) : '', reply: 'Thinking...', footer: '' })
  }

  if (!card) return fit({ ...blank, body: 'All clear.' })

  const choices = choicesFor(card)
  const choice = choices[s.choice]
  const isDraft = choice !== LATER && choice !== DONE
  const header = `${LABEL[card.category]}  ${urgencyBar(card.urgency)}   ${s.index + 1}/${s.cards.length}`
  const meta = `${card.chatTitle} · ${card.from}${card.source === 'quick' ? ' · quick drafts' : ''}`

  let reply = isDraft ? `▶ ${s.choice + 1}/${card.drafts.length}  ${choice}` : `▶ ${choice}`
  let footer = s.message || HINT_CARD
  if (s.mode === 'arming') footer = 'Sending in 2 s · tap to cancel'
  if (s.mode === 'sending') footer = 'Sending...'
  if (s.mode === 'listening') {
    reply = '● Listening... release to finish'
    footer = 'say the change, e.g. "make it 11, not 10"'
  }

  return fit({ header, meta, body: cardBody(s), reply, footer })
}

function cardBody(s: DeskState): string {
  const card = current(s)
  if (!card) return ''
  const snippet = clip(sanitize(card.snippet), 110)
  return `${clip(sanitize(card.summary), 64)}\n"${snippet}"`
}

/** "Nina is answering: Client" lines for the all-clear screen; at most 2, then "+N more". */
function takenLines(s: DeskState): string[] {
  const lines = s.taken.slice(0, 2).map(t => clip(`${t.by} is answering: ${sanitize(t.chatTitle)}`, 46))
  if (s.taken.length > 2) lines.push(`+${s.taken.length - 2} more with teammates`)
  return lines
}
