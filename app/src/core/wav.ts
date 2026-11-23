// The glasses mic delivers PCM 16 kHz, s16le, mono in ~100 ms chunks.
// We buffer a hold-to-talk clip and wrap it in a WAV header for speech-to-text.

export const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2

export class PcmRecorder {
  private chunks: Uint8Array[] = []
  private size = 0
  private readonly maxBytes: number
  recording = false

  /** maxBytes: default 30 s of audio (960 kB). */
  constructor(maxBytes = SAMPLE_RATE * BYTES_PER_SAMPLE * 30) {
    this.maxBytes = maxBytes
  }

  start(): void {
    this.chunks = []
    this.size = 0
    this.recording = true
  }

  push(chunk: Uint8Array): void {
    if (!this.recording || this.size >= this.maxBytes) return
    const room = this.maxBytes - this.size
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk
    this.chunks.push(part.slice())
    this.size += part.length
  }

  seconds(): number {
    return this.size / (SAMPLE_RATE * BYTES_PER_SAMPLE)
  }

  /** Stops and returns the joined PCM, trimmed to whole samples. */
  stop(): Uint8Array {
    this.recording = false
    const even = this.size - (this.size % BYTES_PER_SAMPLE)
    const out = new Uint8Array(even)
    let offset = 0
    for (const c of this.chunks) {
      const n = Math.min(c.length, even - offset)
      if (n <= 0) break
      out.set(c.subarray(0, n), offset)
      offset += n
    }
    this.chunks = []
    this.size = 0
    return out
  }
}

export function toWav(pcm: Uint8Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const out = new Uint8Array(44 + pcm.length)
  const v = new DataView(out.buffer)
  const write = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i) }
  write(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true)
  v.setUint16(32, BYTES_PER_SAMPLE, true)
  v.setUint16(34, 16, true)
  write(36, 'data')
  v.setUint32(40, pcm.length, true)
  out.set(pcm, 44)
  return out
}
