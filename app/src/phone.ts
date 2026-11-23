// Phone-side companion UI (the WebView page itself): pairing, demo, a mirror of the glasses.

import type { Screen } from './core/render.ts'

export interface PhoneHandlers {
  onPair(code: string): Promise<string | null>
  onDemo(): Promise<string | null>
  onUnpair(): void
}

const BOT = (import.meta.env.VITE_BOT_USERNAME as string | undefined) ?? 'GlanceDeskHokenBot'

let root: HTMLElement
let handlers: PhoneHandlers

export function mountPhone(h: PhoneHandlers): void {
  handlers = h
  root = document.querySelector<HTMLElement>('#app')!
  injectStyles()
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function showUnpaired(note = ''): void {
  root.innerHTML = `
    <main class="panel">
      <h1>Glance Desk</h1>
      <p class="lead">Your Telegram work chats, triaged on your glasses. Approve an AI-drafted reply with one tap.</p>
      <ol class="steps">
        <li>In Telegram, open <b>@${esc(BOT)}</b> and send <code>/start</code>.</li>
        <li>Type the 6-digit code here:</li>
      </ol>
      <form id="pair" class="row">
        <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="123456" aria-label="Pairing code" required>
        <button type="submit">Pair</button>
      </form>
      <p class="hint">Then add the bot to a work group and send <code>/watch</code> there.</p>
      <div class="sep">or</div>
      <button id="demo" class="ghost">Try the demo with sample chats</button>
      <p id="note" class="note" role="status">${esc(note)}</p>
    </main>`
  const note$ = root.querySelector<HTMLElement>('#note')!
  root.querySelector<HTMLFormElement>('#pair')!.addEventListener('submit', async e => {
    e.preventDefault()
    const code = root.querySelector<HTMLInputElement>('#code')!.value.trim()
    note$.textContent = 'Pairing…'
    note$.textContent = (await handlers.onPair(code)) ?? ''
  })
  root.querySelector<HTMLButtonElement>('#demo')!.addEventListener('click', async () => {
    note$.textContent = 'Creating demo…'
    note$.textContent = (await handlers.onDemo()) ?? ''
  })
}

export function showPaired(view: Screen, demo: boolean): void {
  root.innerHTML = `
    <main class="panel">
      <header class="row between">
        <h1>Glance Desk</h1>
        <span class="chip">${demo ? 'Demo' : 'Paired'}</span>
      </header>
      <section class="glasses" aria-label="What your glasses show">
        <div class="g-header">${esc(view.header)}</div>
        <div class="g-meta">${esc(view.meta)}</div>
        <div class="g-body">${esc(view.body)}</div>
        <div class="g-reply">${esc(view.reply)}</div>
        <div class="g-footer">${esc(view.footer)}</div>
      </section>
      <p class="hint">On the glasses: swipe to choose a reply, tap to send (2 s to cancel), hold to dictate a change, double tap to exit. Tap-and-hold opens the menu (Refresh, Digest).</p>
      <button id="unpair" class="ghost">${demo ? 'Leave demo' : 'Unpair this phone'}</button>
    </main>`
  root.querySelector<HTMLButtonElement>('#unpair')!.addEventListener('click', () => handlers.onUnpair())
}

function injectStyles(): void {
  const css = `
    :root { color-scheme: dark; }
    html, body { margin: 0; background: #1d1f1d; color: #e6e6e6; font: 16px/1.45 system-ui, -apple-system, sans-serif; }
    .panel { max-width: 560px; margin: 0 auto; padding: 20px 16px 32px; box-sizing: border-box; }
    h1 { font-size: 20px; margin: 0 0 8px; }
    .lead { color: #bdbdbd; margin: 0 0 16px; }
    .steps { padding-left: 20px; margin: 0 0 8px; }
    .row { display: flex; gap: 8px; align-items: center; }
    .between { justify-content: space-between; }
    input { flex: 1; font-size: 22px; letter-spacing: 6px; padding: 10px 12px; border-radius: 10px; border: 1px solid #4a4a4a; background: #2a2c2a; color: #fff; min-width: 0; }
    button { font: inherit; padding: 12px 16px; border-radius: 10px; border: 0; background: #3cfa44; color: #0b1a0b; font-weight: 600; min-height: 44px; }
    button.ghost { background: transparent; color: #e6e6e6; border: 1px solid #5a5a5a; width: 100%; }
    button:focus-visible, input:focus-visible { outline: 3px solid #9dffa1; outline-offset: 2px; }
    .hint { color: #a9a9a9; font-size: 14px; }
    .note { min-height: 1.4em; color: #9dffa1; }
    .sep { text-align: center; color: #777; margin: 12px 0; }
    code { background: #2a2c2a; padding: 1px 5px; border-radius: 4px; }
    .chip { font-size: 12px; border: 1px solid #3cfa44; color: #3cfa44; border-radius: 999px; padding: 3px 10px; }
    .glasses { background: #000; color: #3cfa44; border-radius: 12px; padding: 14px; font: 14px/1.4 ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word; margin: 12px 0; }
    .g-meta, .g-footer { opacity: .6; }
    .g-body { opacity: .85; margin: 6px 0; min-height: 3em; }
    .g-reply { border: 1px solid #3cfa44; border-radius: 6px; padding: 6px 8px; margin: 6px 0; min-height: 1.4em; }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
