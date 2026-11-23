// Pure state machine for the glasses UI. No SDK, no DOM, no timers:
// main.ts turns the returned effects into network calls and timeouts.

import type { Card, Queue } from './types.ts'

export const LATER = '○ Later'
export const DONE = '■ Done, no reply'

export type Mode =
  | 'loading' | 'card' | 'arming' | 'sending' | 'sent'
  | 'listening' | 'thinking' | 'empty' | 'digest' | 'error'

export interface DeskState {
  cards: Card[]
  index: number
  /** Index into choicesFor(current card): drafts, then LATER, then DONE. */
  choice: number
  mode: Mode
  /** Transient one-line note (errors, "sent to Ops"). */
  message: string
  digest: string[]
  quietCount: number
}

export type Effect =
  | { kind: 'none' }
  | { kind: 'arm' }
  | { kind: 'cancel' }
  | { kind: 'send'; cardId: string; text: string }
  | { kind: 'later'; cardId: string }
  | { kind: 'done'; cardId: string }
  | { kind: 'digest' }
  | { kind: 'refresh' }

const NONE: Effect = { kind: 'none' }

export function initialState(): DeskState {
  return { cards: [], index: 0, choice: 0, mode: 'loading', message: '', digest: [], quietCount: 0 }
}

export function choicesFor(card: Card): string[] {
  return [...card.drafts, LATER, DONE]
}

export function current(s: DeskState): Card | undefined {
  return s.cards[s.index]
}

function onCards(s: DeskState, cards: Card[], message = ''): DeskState {
  return {
    ...s,
    cards,
    index: 0,
    choice: 0,
    mode: cards.length ? 'card' : 'empty',
    message,
  }
}

export function loaded(s: DeskState, q: Queue): DeskState {
  return { ...onCards(s, q.cards), quietCount: q.quietCount }
}

export function failed(s: DeskState, message: string): DeskState {
  return { ...s, mode: 'error', message }
}

export function move(s: DeskState, delta: number): DeskState {
  const card = current(s)
  if (s.mode !== 'card' || !card) return s
  const n = choicesFor(card).length
  return { ...s, choice: (((s.choice + delta) % n) + n) % n, message: '' }
}

export function tap(s: DeskState): [DeskState, Effect] {
  const card = current(s)
  switch (s.mode) {
    case 'card': {
      if (!card) return [s, NONE]
      const choice = choicesFor(card)[s.choice]
      if (choice === LATER) {
        const rest = s.cards.filter((_, i) => i !== s.index)
        return [onCards(s, [...rest, card]), { kind: 'later', cardId: card.id }]
      }
      if (choice === DONE) {
        const rest = s.cards.filter((_, i) => i !== s.index)
        return [onCards(s, rest), { kind: 'done', cardId: card.id }]
      }
      return [{ ...s, mode: 'arming', message: '' }, { kind: 'arm' }]
    }
    case 'arming':
      return [{ ...s, mode: 'card' }, { kind: 'cancel' }]
    case 'empty':
      return [{ ...s, mode: 'thinking' }, { kind: 'digest' }]
    case 'digest':
      return [{ ...s, mode: s.cards.length ? 'card' : 'empty' }, NONE]
    case 'error':
      return [{ ...s, mode: 'loading', message: '' }, { kind: 'refresh' }]
    default:
      return [s, NONE]
  }
}

export function armExpired(s: DeskState): [DeskState, Effect] {
  const card = current(s)
  if (s.mode !== 'arming' || !card) return [s, NONE]
  const text = choicesFor(card)[s.choice]
  return [{ ...s, mode: 'sending' }, { kind: 'send', cardId: card.id, text }]
}

export function sendResult(s: DeskState, ok: boolean, message = ''): DeskState {
  if (!ok) return { ...s, mode: 'card', message: message || 'Not sent' }
  const card = current(s)
  const rest = s.cards.filter((_, i) => i !== s.index)
  return { ...s, cards: rest, index: 0, choice: 0, mode: 'sent', message: card ? `Sent to ${card.chatTitle}` : 'Sent' }
}

export function settle(s: DeskState): DeskState {
  if (s.mode !== 'sent') return s
  return onCards(s, s.cards)
}

export function startListening(s: DeskState): DeskState {
  if (s.mode !== 'card' || !current(s)) return s
  return { ...s, mode: 'listening', message: '' }
}

export function stopListening(s: DeskState): DeskState {
  if (s.mode !== 'listening') return s
  return { ...s, mode: 'thinking' }
}

/** A dictated edit lands in the selected draft (or in front, if Later/Done was selected). */
export function replaceDraft(s: DeskState, text: string): DeskState {
  const card = current(s)
  if (!card) return { ...s, mode: 'empty' }
  const drafts = [...card.drafts]
  let choice = s.choice
  if (choice < drafts.length) {
    drafts[choice] = text
  } else {
    drafts.unshift(text)
    drafts.length = Math.min(drafts.length, 3)
    choice = 0
  }
  const cards = s.cards.map((c, i) => (i === s.index ? { ...c, drafts, source: 'ai' as const } : c))
  return { ...s, cards, choice, mode: 'card', message: '' }
}

export function dictationFailed(s: DeskState, message: string): DeskState {
  return { ...s, mode: current(s) ? 'card' : 'empty', message }
}

export function digestLoaded(s: DeskState, lines: string[]): DeskState {
  return { ...s, mode: 'digest', digest: lines }
}
