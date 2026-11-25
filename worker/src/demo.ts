// Synthetic work chats for the "Try the demo" mode. Fictional people and companies.

export interface DemoChat {
  title: string
  messages: { from: string; text: string }[]
}

/** In the demo, teammate Nina is already answering this thread. */
export const DEMO_TEAMMATE_CHAT = 'Ops · Warehouse'

export const DEMO_CHATS: DemoChat[] = [
  {
    title: 'Ops · Warehouse',
    messages: [
      { from: 'Marco', text: 'Buongiorno, i 3 pallet per Bari sono pronti.' },
      { from: 'Marco', text: 'Il corriere chiede se può passare domani alle 9 o alle 14. Cosa gli dico?' },
    ],
  },
  {
    title: 'Client · Bianchi Srl',
    messages: [
      { from: 'Laura Bianchi', text: 'Ciao, abbiamo visto il preventivo.' },
      { from: 'Laura Bianchi', text: 'Se ci fate il 5% di sconto confermiamo l\'ordine entro oggi. Si può fare?' },
    ],
  },
  {
    title: 'Dev team',
    messages: [
      { from: 'Sam', text: 'Heads up: staging is down after the 11:40 deploy.' },
      { from: 'Sam', text: 'Can I roll back now, or do you want to look first? Urgent, the client demo is at 3pm.' },
    ],
  },
  {
    title: 'Admin',
    messages: [
      { from: 'Giulia', text: 'Ho caricato le fatture di novembre nella cartella condivisa.' },
      { from: 'Giulia', text: 'Il commercialista le prende venerdì.' },
    ],
  },
  {
    title: 'Team social',
    messages: [
      { from: 'Paolo', text: 'Foto della cena di ieri nel drive' },
      { from: 'Anna', text: 'grazie!' },
    ],
  },
]
