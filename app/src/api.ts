// Thin client for the Glance Desk Worker. The token is a device token from pairing.

import type { Queue } from './core/types.ts'

export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'https://glance-desk.infocryptorepublic.workers.dev'

export class ApiError extends Error {
  readonly status: number
  /** On 409: first name of the teammate who holds or answered the thread. */
  readonly by: string
  constructor(status: number, message: string, by = '') {
    super(message)
    this.status = status
    this.by = by
  }
}

async function call<T>(path: string, init: RequestInit & { token?: string; timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 30_000)
  try {
    const res = await fetch(API_BASE + path, {
      ...init,
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
    })
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; by?: string }
    if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`, data.by ?? '')
    return data
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw new ApiError(0, (e as Error).name === 'AbortError' ? 'Timed out' : 'Offline')
  } finally {
    clearTimeout(timer)
  }
}

export const api = {
  pair: (code: string) => call<{ token: string }>('/api/pair', { method: 'POST', body: JSON.stringify({ code }) }),
  demo: () => call<{ token: string; teammateToken?: string }>('/api/demo', { method: 'POST' }),
  queue: (token: string) => call<Queue>('/api/queue', { token, timeoutMs: 45_000 }),
  digest: (token: string) => call<{ lines: string[] }>('/api/digest', { token }),
  claim: (token: string, id: string) => call<{ ok: boolean }>(`/api/cards/${encodeURIComponent(id)}/claim`, { method: 'POST', token }),
  send: (token: string, id: string, text: string) =>
    call<{ ok: boolean; signedAs?: string }>(`/api/cards/${encodeURIComponent(id)}/send`, { method: 'POST', token, body: JSON.stringify({ text }) }),
  later: (token: string, id: string) => call<{ ok: boolean }>(`/api/cards/${encodeURIComponent(id)}/later`, { method: 'POST', token }),
  done: (token: string, id: string) => call<{ ok: boolean }>(`/api/cards/${encodeURIComponent(id)}/done`, { method: 'POST', token }),
  dictate: (token: string, id: string, draft: string, wav: Uint8Array) =>
    call<{ draft: string; heard: string }>(`/api/cards/${encodeURIComponent(id)}/dictate`, {
      method: 'POST', token, body: JSON.stringify({ draft, audio: toBase64(wav) }),
    }),
}

export function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
