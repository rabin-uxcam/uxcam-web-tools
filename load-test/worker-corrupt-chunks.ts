import { parentPort, workerData } from 'node:worker_threads'
import { gzipSync } from 'node:zlib'
import { io, type Socket } from 'socket.io-client'
import {
  makeSessionId,
  makeDeviceId,
  makeSessionInitPayload,
  buildSessionBatches,
} from './payloads.js'

/**
 * Corrupt-chunks worker
 *
 * Sends sessions with various corrupted gzip payloads to test
 * the backend's skip-and-continue decompression logic.
 */

interface WorkerConfig {
  wsURL: string
  appKey: string
  connectionCount: number
  scenario: 'mixed-chunks' | 'all-corrupted' | 'truncated-gzip'
}

type MetricEvent =
  | { type: 'connecting' }
  | { type: 'connected'; latencyMs: number }
  | { type: 'connect_error'; error: string }
  | { type: 'init_sent'; sessionId: string }
  | { type: 'data_sent'; bytes: number; sessionId: string; label: string }
  | { type: 'session_abort'; reason: string; sessionId: string }
  | { type: 'disconnected'; sessionId: string }
  | { type: 'scenario_done'; sessionId: string; scenario: string }
  | { type: 'done' }

function emit(event: MetricEvent) {
  parentPort?.postMessage(event)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- Corrupt buffer generators ---

/** Completely invalid data — not gzip at all */
function makeGarbageBuffer(): Buffer {
  return Buffer.from('this is not gzip data, just garbage text to break decompression')
}

/** Valid gzip magic bytes (1f 8b) + header, but body truncated mid-stream.
 *  This reproduces the exact "unexpected end of file" error from production. */
function makeTruncatedGzipBuffer(): Buffer {
  const validGzip = gzipSync(Buffer.from(JSON.stringify([
    { t: '1', s: 999, d: { corrupted: true, payload: 'x'.repeat(200) } },
  ])))
  // Cut off the last 30% of the gzip stream — removes the footer + part of the compressed body
  return validGzip.subarray(0, Math.floor(validGzip.length * 0.7))
}

// --- Socket helper ---

function createSocket(config: WorkerConfig, sessionId: string): Socket {
  return io(config.wsURL, {
    autoConnect: true,
    transports: ['websocket'],
    reconnection: false,
    timeout: 30000,
    query: {
      appKey: config.appKey,
      sessId: sessionId,
      reconnected: '0',
      captureMode: 'dom',
    },
    rejectUnauthorized: true,
  } as Parameters<typeof io>[1])
}

// ──────────────────────────────────────────────
// Scenario: mixed-chunks
// Send valid gzip batch, then a corrupted chunk, then another valid batch.
// Backend should skip the bad chunk and upload the session with valid data.
// ──────────────────────────────────────────────
async function scenarioMixedChunks(config: WorkerConfig): Promise<void> {
  const sessionId = makeSessionId()
  const deviceId = makeDeviceId()

  const validBatches = buildSessionBatches(sessionId, 10)
  const corruptBuffer = makeGarbageBuffer()

  emit({ type: 'connecting' })
  const connectStart = Date.now()

  return new Promise<void>((resolve) => {
    const socket = createSocket(config, sessionId)

    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (socket.connected) socket.disconnect()
      emit({ type: 'disconnected', sessionId })
      resolve()
    }

    const timeout = setTimeout(() => {
      emit({ type: 'connect_error', error: 'timeout after 30s' })
      finish()
    }, 30_000)

    socket.on('connect_error', (err: Error) => {
      clearTimeout(timeout)
      emit({ type: 'connect_error', error: err.message })
      finish()
    })

    socket.on('session_abort', (reason: string) => {
      emit({ type: 'session_abort', reason, sessionId })
    })

    socket.on('disconnect', () => {
      clearTimeout(timeout)
      finish()
    })

    socket.on('connect', async () => {
      clearTimeout(timeout)
      emit({ type: 'connected', latencyMs: Date.now() - connectStart })

      // 1. session_init
      socket.emit('session_init', makeSessionInitPayload(sessionId, deviceId, config.appKey))
      emit({ type: 'init_sent', sessionId })
      await sleep(100)

      // 2. First valid batch (page load)
      if (validBatches.length > 0) {
        socket.emit('session_data', validBatches[0])
        emit({ type: 'data_sent', bytes: validBatches[0].data.length, sessionId, label: 'valid-batch-0' })
        await sleep(200)
      }

      // 3. Corrupted chunk
      socket.emit('session_data', { sid: sessionId, data: corruptBuffer, vi: true })
      emit({ type: 'data_sent', bytes: corruptBuffer.length, sessionId, label: 'CORRUPT-garbage' })
      await sleep(200)

      // 4. Second valid batch
      if (validBatches.length > 1) {
        socket.emit('session_data', validBatches[1])
        emit({ type: 'data_sent', bytes: validBatches[1].data.length, sessionId, label: 'valid-batch-1' })
      }

      await sleep(1000)
      emit({ type: 'scenario_done', sessionId, scenario: 'mixed-chunks' })
      finish()
    })
  })
}

// ──────────────────────────────────────────────
// Scenario: all-corrupted
// Send session_init + only corrupted chunks (no valid data at all).
// Backend should trigger "All chunks corrupted" → tryCancelSession reason 3.
// ──────────────────────────────────────────────
async function scenarioAllCorrupted(config: WorkerConfig): Promise<void> {
  const sessionId = makeSessionId()
  const deviceId = makeDeviceId()

  emit({ type: 'connecting' })
  const connectStart = Date.now()

  return new Promise<void>((resolve) => {
    const socket = createSocket(config, sessionId)

    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (socket.connected) socket.disconnect()
      emit({ type: 'disconnected', sessionId })
      resolve()
    }

    const timeout = setTimeout(() => {
      emit({ type: 'connect_error', error: 'timeout after 30s' })
      finish()
    }, 30_000)

    socket.on('connect_error', (err: Error) => {
      clearTimeout(timeout)
      emit({ type: 'connect_error', error: err.message })
      finish()
    })

    socket.on('session_abort', (reason: string) => {
      emit({ type: 'session_abort', reason, sessionId })
    })

    socket.on('disconnect', () => {
      clearTimeout(timeout)
      finish()
    })

    socket.on('connect', async () => {
      clearTimeout(timeout)
      emit({ type: 'connected', latencyMs: Date.now() - connectStart })

      // 1. session_init
      socket.emit('session_init', makeSessionInitPayload(sessionId, deviceId, config.appKey))
      emit({ type: 'init_sent', sessionId })
      await sleep(100)

      // 2. Send 3 corrupted chunks — mix of garbage and truncated gzip
      const corrupts = [
        { buf: makeGarbageBuffer(), label: 'CORRUPT-garbage-1' },
        { buf: makeTruncatedGzipBuffer(), label: 'CORRUPT-truncated-1' },
        { buf: makeGarbageBuffer(), label: 'CORRUPT-garbage-2' },
      ]

      for (const { buf, label } of corrupts) {
        socket.emit('session_data', { sid: sessionId, data: buf, vi: true })
        emit({ type: 'data_sent', bytes: buf.length, sessionId, label })
        await sleep(200)
      }

      await sleep(1000)
      emit({ type: 'scenario_done', sessionId, scenario: 'all-corrupted' })
      finish()
    })
  })
}

// ──────────────────────────────────────────────
// Scenario: truncated-gzip
// Send valid batch + a truncated gzip (has valid 1f 8b header but body cut short).
// This is the exact production failure mode: "unexpected end of file".
// Backend should skip the truncated chunk and process valid ones.
// ──────────────────────────────────────────────
async function scenarioTruncatedGzip(config: WorkerConfig): Promise<void> {
  const sessionId = makeSessionId()
  const deviceId = makeDeviceId()

  const validBatches = buildSessionBatches(sessionId, 10)
  const truncatedBuffer = makeTruncatedGzipBuffer()

  emit({ type: 'connecting' })
  const connectStart = Date.now()

  return new Promise<void>((resolve) => {
    const socket = createSocket(config, sessionId)

    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (socket.connected) socket.disconnect()
      emit({ type: 'disconnected', sessionId })
      resolve()
    }

    const timeout = setTimeout(() => {
      emit({ type: 'connect_error', error: 'timeout after 30s' })
      finish()
    }, 30_000)

    socket.on('connect_error', (err: Error) => {
      clearTimeout(timeout)
      emit({ type: 'connect_error', error: err.message })
      finish()
    })

    socket.on('session_abort', (reason: string) => {
      emit({ type: 'session_abort', reason, sessionId })
    })

    socket.on('disconnect', () => {
      clearTimeout(timeout)
      finish()
    })

    socket.on('connect', async () => {
      clearTimeout(timeout)
      emit({ type: 'connected', latencyMs: Date.now() - connectStart })

      // 1. session_init
      socket.emit('session_init', makeSessionInitPayload(sessionId, deviceId, config.appKey))
      emit({ type: 'init_sent', sessionId })
      await sleep(100)

      // 2. Valid page load batch
      if (validBatches.length > 0) {
        socket.emit('session_data', validBatches[0])
        emit({ type: 'data_sent', bytes: validBatches[0].data.length, sessionId, label: 'valid-batch-0' })
        await sleep(200)
      }

      // 3. Truncated gzip — exact production error pattern
      socket.emit('session_data', { sid: sessionId, data: truncatedBuffer, vi: true })
      emit({ type: 'data_sent', bytes: truncatedBuffer.length, sessionId, label: 'CORRUPT-truncated-gzip' })
      await sleep(200)

      // 4. More valid data after the corrupted one
      if (validBatches.length > 1) {
        socket.emit('session_data', validBatches[1])
        emit({ type: 'data_sent', bytes: validBatches[1].data.length, sessionId, label: 'valid-batch-1' })
      }

      await sleep(1000)
      emit({ type: 'scenario_done', sessionId, scenario: 'truncated-gzip' })
      finish()
    })
  })
}

// --- Dispatch ---

const scenarioRunners: Record<string, (config: WorkerConfig) => Promise<void>> = {
  'mixed-chunks': scenarioMixedChunks,
  'all-corrupted': scenarioAllCorrupted,
  'truncated-gzip': scenarioTruncatedGzip,
}

async function main() {
  const config = workerData as WorkerConfig
  const runner = scenarioRunners[config.scenario]

  if (!runner) {
    console.error(`Unknown scenario: ${config.scenario}`)
    process.exit(1)
  }

  for (let i = 0; i < config.connectionCount; i++) {
    await runner(config)
    await sleep(500)
  }

  emit({ type: 'done' })
}

main().catch((err) => {
  console.error(`[Worker] Fatal:`, err)
  process.exit(1)
})
