// Glance Desk: Even G2 plugin entry. Wires the bridge, the pure desk state machine,
// the Worker API and the phone companion UI.

import {
  waitForEvenAppBridge, TextContainerProperty, TextContainerUpgrade, CreateStartUpPageContainer,
  MenuContainerProperty, MenuItemProperty, OsEventTypeList, AudioInputSource, type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import {
  initialState, loaded, failed, move, tap, armExpired, sendResult, settle, startListening, stopListening,
  replaceDraft, dictationFailed, digestLoaded, current, choicesFor, type DeskState, type Effect,
} from './core/desk.ts'
import { screen, LAYOUT, type Field, type Screen } from './core/render.ts'
import { PcmRecorder, toWav } from './core/wav.ts'
import { api, ApiError } from './api.ts'
import { mountPhone, showPaired, showUnpaired } from './phone.ts'

const TOKEN_KEY = 'glance_desk_token'
const DEMO_KEY = 'glance_desk_demo'
const MENU = { refresh: 1, digest: 2 } as const
const ARM_MS = 2000
const SENT_MS = 1200
const POLL_MS = 20_000

const bridge: EvenAppBridge = await waitForEvenAppBridge()

let state: DeskState = initialState()
let token = ''
let demo = false
let armTimer: number | null = null
const recorder = new PcmRecorder()

// ---------- storage ----------

async function loadToken(): Promise<void> {
  token = (await bridge.getLocalStorage(TOKEN_KEY).catch(() => '')) || localStorage.getItem(TOKEN_KEY) || ''
  demo = ((await bridge.getLocalStorage(DEMO_KEY).catch(() => '')) || localStorage.getItem(DEMO_KEY) || '') === '1'
}

async function saveToken(t: string, isDemo: boolean): Promise<void> {
  token = t
  demo = isDemo
  localStorage.setItem(TOKEN_KEY, t)
  localStorage.setItem(DEMO_KEY, isDemo ? '1' : '')
  await bridge.setLocalStorage(TOKEN_KEY, t).catch(() => false)
  await bridge.setLocalStorage(DEMO_KEY, isDemo ? '1' : '').catch(() => false)
}

// ---------- glasses page ----------

const fields = Object.keys(LAYOUT) as Field[]
let shown: Screen = { header: '', meta: '', body: '', reply: '', footer: '' }

function containers(view: Screen): TextContainerProperty[] {
  return fields.map(f => {
    const b = LAYOUT[f]
    return new TextContainerProperty({
      xPosition: b.x, yPosition: b.y, width: b.w, height: b.h,
      borderWidth: b.border, borderColor: 8, borderRadius: 4, paddingLength: b.pad,
      containerID: b.id, containerName: b.name, content: view[f] || ' ',
      textColor: b.brightness, isEventCapture: b.capture ? 1 : 0,
    })
  })
}

const menu = new MenuContainerProperty({
  menuItems: [
    new MenuItemProperty({ itemName: 'Refresh', itemID: MENU.refresh }),
    new MenuItemProperty({ itemName: 'Digest', itemID: MENU.digest }),
  ],
})

let renderChain: Promise<unknown> = Promise.resolve()

function render(): void {
  const view = screen(state)
  if (token) showPaired(view, demo)
  // Serialize BLE writes; only push containers whose text changed.
  renderChain = renderChain.then(async () => {
    for (const f of fields) {
      if (view[f] === shown[f]) continue
      const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: LAYOUT[f].id, containerName: LAYOUT[f].name, content: view[f] || ' ',
      }))
      if (ok) shown = { ...shown, [f]: view[f] }
    }
  }).catch(e => console.error('render', e))
}

function set(next: DeskState): void {
  state = next
  render()
}

// ---------- effects ----------

function errorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 401) return 'Not paired. Open Glance Desk on your phone.'
  return e instanceof Error ? e.message : 'Something went wrong'
}

async function refresh(): Promise<void> {
  if (!token) {
    set(failed(state, 'Not paired. Open Glance Desk on your phone.'))
    return
  }
  try {
    const keep = current(state)?.id
    let next = loaded(state, await api.queue(token))
    const i = keep ? next.cards.findIndex(c => c.id === keep) : -1
    if (i > 0) next = { ...next, index: i }
    set(next)
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      await saveToken('', false)
      showUnpaired('This phone is no longer paired.')
    }
    set(failed(state, errorText(e)))
  }
}

async function run(effect: Effect): Promise<void> {
  switch (effect.kind) {
    case 'arm':
      armTimer = window.setTimeout(() => {
        armTimer = null
        const [next, e] = armExpired(state)
        set(next)
        void run(e)
      }, ARM_MS)
      return
    case 'cancel':
      if (armTimer !== null) clearTimeout(armTimer)
      armTimer = null
      return
    case 'send':
      try {
        await api.send(token, effect.cardId, effect.text)
        set(sendResult(state, true))
        window.setTimeout(() => set(settle(state)), SENT_MS)
      } catch (e) {
        set(sendResult(state, false, errorText(e)))
      }
      return
    case 'later':
      api.later(token, effect.cardId).catch(e => set({ ...state, message: errorText(e) }))
      return
    case 'done':
      api.done(token, effect.cardId).catch(e => set({ ...state, message: errorText(e) }))
      return
    case 'digest':
      try {
        set(digestLoaded(state, (await api.digest(token)).lines))
      } catch (e) {
        set(failed(state, errorText(e)))
      }
      return
    case 'refresh':
      await refresh()
      return
  }
}

// ---------- dictation (hold to talk) ----------

async function beginDictation(): Promise<void> {
  const next = startListening(state)
  if (next === state) return
  set(next)
  recorder.start()
  await bridge.audioControl(true, AudioInputSource.Glasses)
}

async function endDictation(): Promise<void> {
  if (state.mode !== 'listening') return
  await bridge.audioControl(false)
  let pcm = recorder.stop()
  set(stopListening(state))
  // Dev-only, for simulators on machines without a microphone: ?mic feeds a recorded
  // 16 kHz WAV as the mic input; transcription and rewriting still run for real.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('mic') && pcm.length < 16000) {
    const wav = new Uint8Array(await (await fetch('/dev-mic-sample.wav')).arrayBuffer())
    let at = 12 // skip RIFF/WAVE, then walk the chunks to "data"
    while (at + 8 <= wav.length && String.fromCharCode(...wav.subarray(at, at + 4)) !== 'data') {
      at += 8 + new DataView(wav.buffer, wav.byteOffset + at + 4, 4).getUint32(0, true)
    }
    pcm = wav.subarray(at + 8)
  }
  const card = current(state)
  if (!card || pcm.length < 16000 * 2 * 0.4) {
    set(dictationFailed(state, 'Too short. Hold while you speak.'))
    return
  }
  const draft = choicesFor(card)[state.choice] ?? ''
  try {
    const r = await api.dictate(token, card.id, card.drafts.includes(draft) ? draft : '', toWav(pcm))
    set(replaceDraft(state, r.draft))
  } catch (e) {
    set(dictationFailed(state, errorText(e)))
  }
}

// ---------- input ----------

function typeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  // CLICK_EVENT is 0 and protobuf drops zero values, so a tap arrives without eventType.
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

bridge.onEvenHubEvent(event => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm) {
    recorder.push(pcm)
    return
  }

  const menuId = event.menuItemClickEvent?.itemID
  if (menuId === MENU.refresh) {
    set({ ...state, mode: 'loading' })
    void refresh()
    return
  }
  if (menuId === MENU.digest) {
    set({ ...state, mode: 'thinking' })
    void run({ kind: 'digest' })
    return
  }

  const sys = typeOf(event.sysEvent)
  const text = typeOf(event.textEvent)

  if (sys === OsEventTypeList.LONG_PRESS_EVENT) return void beginDictation()
  if (sys === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) return void endDictation()
  if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    if (state.mode === 'listening') void bridge.audioControl(false)
    return
  }
  if (sys === OsEventTypeList.FOREGROUND_ENTER_EVENT || sys === OsEventTypeList.FOREGROUND_EXIT_EVENT) return
  if (sys === OsEventTypeList.IMU_DATA_REPORT) return

  const type = text ?? sys
  if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    void bridge.shutDownPageContainer(1) // root page: system exit dialog
    return
  }
  if (type === OsEventTypeList.SCROLL_TOP_EVENT) return set(move(state, -1))
  if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) return set(move(state, 1))
  if (type === OsEventTypeList.CLICK_EVENT) {
    const [next, effect] = tap(state)
    set(next)
    void run(effect)
  }
})

// ---------- phone companion ----------

mountPhone({
  async onPair(code) {
    try {
      const r = await api.pair(code)
      await saveToken(r.token, false)
      set({ ...state, mode: 'loading' })
      await refresh()
      return null
    } catch (e) {
      return errorText(e)
    }
  },
  async onDemo() {
    try {
      const r = await api.demo()
      await saveToken(r.token, true)
      set({ ...state, mode: 'loading' })
      await refresh()
      return null
    } catch (e) {
      return errorText(e)
    }
  },
  onUnpair() {
    void saveToken('', false).then(() => {
      state = initialState()
      showUnpaired()
      set(failed(state, 'Not paired. Open Glance Desk on your phone.'))
    })
  },
})

// ---------- boot ----------

const created = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
  containerTotalNum: fields.length,
  textObject: containers(screen(state)),
  menuObject: menu,
}))
if (created !== 0) console.error('createStartUpPageContainer failed', created)
shown = screen(state)

await loadToken()
// Dev-only shortcut for the simulator (its phone pane can't be clicked by automation):
// ?demo always starts a fresh demo account.
const devDemo = import.meta.env.DEV && new URLSearchParams(location.search).has('demo')
if (devDemo) {
  const r = await api.demo()
  await saveToken(r.token, true)
}
if (token) {
  render()
  await refresh()
} else {
  showUnpaired()
  set(failed(state, 'Not paired. Open Glance Desk on your phone.'))
}

// Quiet polling: only while nothing needs the user, so a new message never moves a card under their finger.
window.setInterval(() => {
  if (token && state.mode === 'empty') void refresh()
}, POLL_MS)
