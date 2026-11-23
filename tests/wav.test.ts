import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PcmRecorder, toWav } from '../app/src/core/wav.ts'

test('toWav writes a 44-byte RIFF header for 16 kHz mono s16le', () => {
  const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0])
  const wav = toWav(pcm)
  const v = new DataView(wav.buffer)
  const ascii = (o: number) => String.fromCharCode(...wav.slice(o, o + 4))
  assert.equal(wav.length, 44 + 8)
  assert.equal(ascii(0), 'RIFF')
  assert.equal(v.getUint32(4, true), 36 + 8)
  assert.equal(ascii(8), 'WAVE')
  assert.equal(ascii(12), 'fmt ')
  assert.equal(v.getUint16(20, true), 1) // PCM
  assert.equal(v.getUint16(22, true), 1) // mono
  assert.equal(v.getUint32(24, true), 16000)
  assert.equal(v.getUint32(28, true), 32000) // byte rate
  assert.equal(v.getUint16(32, true), 2) // block align
  assert.equal(v.getUint16(34, true), 16)
  assert.equal(ascii(36), 'data')
  assert.equal(v.getUint32(40, true), 8)
  assert.deepEqual([...wav.slice(44)], [...pcm])
})

test('recorder joins chunks, ignores audio when stopped and caps the length', () => {
  const r = new PcmRecorder(10) // 10 bytes max
  r.push(new Uint8Array([9, 9])) // not recording: ignored
  r.start()
  r.push(new Uint8Array([1, 2, 3, 4]))
  r.push(new Uint8Array([5, 6, 7, 8]))
  r.push(new Uint8Array([9, 10, 11, 12]))
  const pcm = r.stop()
  assert.deepEqual([...pcm], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.equal(r.recording, false)
  r.push(new Uint8Array([1]))
  assert.equal(r.stop().length, 0)
})

test('recorder keeps an even byte count so samples are never split', () => {
  const r = new PcmRecorder(7)
  r.start()
  r.push(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
  assert.equal(r.stop().length, 6)
})

test('seconds() reports the recorded duration', () => {
  const r = new PcmRecorder(1_000_000)
  r.start()
  r.push(new Uint8Array(32000))
  assert.equal(r.seconds(), 1)
})
