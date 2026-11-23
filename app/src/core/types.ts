// Shared shapes between the glasses app and the Worker API.

export type Category = 'needs_you' | 'fyi' | 'noise'

export interface Card {
  id: string
  chatTitle: string
  /** Display name of the person who wrote the last message in the thread. */
  from: string
  category: Category
  /** 0 = whenever, 3 = right now. */
  urgency: number
  /** One line, written by the triage model (or the heuristic fallback). */
  summary: string
  /** The last message of the thread, verbatim (trimmed). */
  snippet: string
  /** Up to 3 short reply drafts in the language of the chat. */
  drafts: string[]
  /** 'ai' when the drafts came from the model, 'quick' when from the fallback. */
  source: 'ai' | 'quick'
  /** Unix ms of the last message. */
  at: number
}

export interface Queue {
  cards: Card[]
  /** Count of FYI/noise threads not shown as cards. */
  quietCount: number
}

export interface Digest {
  lines: string[]
}
