import { parentPort, workerData } from 'node:worker_threads'
import { io, type Socket } from 'socket.io-client'
import {
  makeSessionId,
  makeDeviceId,
  makeSessionInitPayload,
  buildSessionBatches,
} from './payloads.js'

/**
 * Ghost-session test worker
 *
 * Tests multiple scenarios where a session could be verified but silently
 * never upload, without triggering tryCancel or rollbar.
 *
 * Scenarios tested per session:
 *
 * A) "connect-and-vanish": Connect (allowRequest verifies), but never send
 *    session_init or session_data. The allowRequest sets config + alive + started,
 *    but no initData ever arrives. Worker sees !isAlive && !isLocked, checks
 *    hasInitData → false → silently returns. Session stays in started list
 *    forever with no cleanup.
 *
 * B) "init-no-data": Send session_init but zero session_data. Worker processes
 *    with empty binData → "Empty screen timeline" → should hit tryCancel.
 *    This verifies the cancellation path works.
 *
 * C) "rapid-reconnect": Connect, send init + data, then immediately reconnect
 *    with reconnected=1 using the SAME session ID. If the first connection's
 *    data and the reconnection race with the worker, data could be lost.
 *
 * D) "delayed-init": Connect, wait 4+ minutes (close to alive TTL expiry),
 *    THEN send session_init + data. Tests the race where alive expires right
 *    as data arrives.
 *
 * E) "corrupt-data": Send session_init + a session_data batch with an invalid
 *    (non-gzip) buffer. Tests whether decompression error is caught.
 */

interface WorkerConfig {
  wsURL: string
  appKey: string
  connectionCount: number
  rampDelayMs: number
  workerId: number
  scenario: 'connect-and-vanish' | 'init-no-data' | 'rapid-reconnect' | 'delayed-init' | 'corrupt-data'
}

type MetricEvent =
  | { type: 'connecting' }
  | { type: 'connected'; latencyMs: number }
  | { type: 'connect_error'; error: string }
  | { type: 'init_sent'; sessionId: string }
  | { type: 'data_sent'; bytes: number; sessionId: string }
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

// ──────────────────────────────────────────────
// Scenario A: connect-and-vanish
// allowRequest verifies → config, alive, started are set
// but we NEVER send session_init → no initData
// disconnect after a short hold
// ──────────────────────────────────────────────
async function scenarioConnectAndVanish(config: WorkerConfig): Promise<void> {
  const sessionId = makeSessionId()
  const connectStart = Date.now()

  emit({ type: 'connecting' })

  return new Promise<void>((resolve) => {
    const socket: Socket = io(config.wsURL, {
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

      // DO NOT send session_init or session_data
      // Just hold the connection briefly and disconnect
      await sleep(2000)
      emit({ type: 'scenario_done', sessionId, scenario: 'connect-and-vanish' })
      finish()
    })
  })
}

// ──────────────────────────────────────────────
// Scenario B: init-no-data
// Send session_init (sets initData) but NO session_data
// Worker should process → empty binData → "Empty screen timeline"
// Should trigger tryCancel — if it doesn't, that's a bug
// ──────────────────────────────────────────────
async function scenarioInitNoData(config: WorkerConfig): Promise<void> {
  const sessionId = makeSessionId()
  const deviceId = makeDeviceId()
  const connectStart = Date.now()

  emit({ type: 'connecting' })

  return new Promise<void>((resolve) => {
    const socket: Socket = io(config.wsURL, {
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

      // Send session_init only — no data
      socket.emit('session_init', makeSessionInitPayload(sessionId, deviceId, config.appKey))
      emit({ type: 'init_sent', sessionId })

      await sleep(1000)
      emit({ type: 'scenario_done', sessionId, scenario: 'init-no-data' })
      finish()
    })
  })
}

// ──────────────────────────────────────────────
// Scenario C: rapid-reconnect
// Connect, send init + 1 batch, disconnect, then immediately reconnect
// with reconnected=1. The second connection sends more data.
// Tests whether data from both connections makes it through.
// ──────────────────────────────────────────────
async function scenarioRapidReconnect(config: WorkerConfig): Promise<void> {
  const sessionId = makeSessionId()
  const deviceId = makeDeviceId()

  const batches = buildSessionBatches(sessionId, 10)

  // --- First connection ---
  await new Promise<void>((resolve) => {
    emit({ type: 'connecting' })
    const connectStart = Date.now()

    const socket: Socket = io(config.wsURL, {
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

    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (socket.connected) socket.disconnect()
      resolve()
    }

    const timeout = setTimeout(() => {
      emit({ type: 'connect_error', error: 'timeout (reconnect phase 1)' })
      finish()
    }, 30_000)

    socket.on('connect_error', (err: Error) => {
      clearTimeout(timeout)
      emit({ type: 'connect_error', error: `phase1: ${err.message}` })
      finish()
    })

    socket.on('connect', async () => {
      clearTimeout(timeout)
      emit({ type: 'connected', latencyMs: Date.now() - connectStart })

      socket.emit('session_init', makeSessionInitPayload(sessionId, deviceId, config.appKey))
      emit({ type: 'init_sent', sessionId })
      await sleep(100)

      // Send first batch only
      if (batches.length > 0) {
        socket.emit('session_data', batches[0])
        emit({ type: 'data_sent', bytes: batches[0].data.length, sessionId })
      }

      await sleep(200)
      finish()
    })
  })

  // Brief gap between connections
  await sleep(500)

  // --- Second connection (reconnect) ---
  await new Promise<void>((resolve) => {
    emit({ type: 'connecting' })
    const connectStart = Date.now()

    const socket: Socket = io(config.wsURL, {
      autoConnect: true,
      transports: ['websocket'],
      reconnection: false,
      timeout: 30000,
      query: {
        appKey: config.appKey,
        sessId: sessionId,
        reconnected: '1',
        captureMode: 'dom',
      },
      rejectUnauthorized: true,
    } as Parameters<typeof io>[1])

    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (socket.connected) socket.disconnect()
      emit({ type: 'disconnected', sessionId })
      resolve()
    }

    const timeout = setTimeout(() => {
      emit({ type: 'connect_error', error: 'timeout (reconnect phase 2)' })
      finish()
    }, 30_000)

    socket.on('connect_error', (err: Error) => {
      clearTimeout(timeout)
      emit({ type: 'connect_error', error: `phase2: ${err.message}` })
      finish()
    })

    socket.on('session_abort', (reason: string) => {
      emit({ type: 'session_abort', reason, sessionId })
    })

    socket.on('connect', async () => {
      clearTimeout(timeout)
      emit({ type: 'connected', latencyMs: Date.now() - connectStart })

      // Send remaining batches on reconnection
      for (let i = 1; i < Math.min(batches.length, 3); i++) {
        socket.emit('session_data', batches[i])
        emit({ type: 'data_sent', bytes: batches[i].data.length, sessionId })
        await sleep(200)
      }

      await sleep(500)
      emit({ type: 'scenario_done', sessionId, scenario: 'rapid-reconnect' })
      finish()
    })
  })
}

// ──────────────────────────────────────────────
// Scenario D: delayed-init
// Connect (allowRequest verifies), wait 4 min 30s (close to 5-min alive TTL),
// THEN send session_init + data. Tests race where alive expires during or
// right after data send.
// ──────────────────────────────────────────────
async function scenarioDelayedInit(config: WorkerConfig): Promise<void> {
  const sessionId = makeSessionId()
  const deviceId = makeDeviceId()
  const connectStart = Date.now()

  const batches = buildSessionBatches(sessionId, 10)

  emit({ type: 'connecting' })

  return new Promise<void>((resolve) => {
    const socket: Socket = io(config.wsURL, {
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

    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (socket.connected) socket.disconnect()
      emit({ type: 'disconnected', sessionId })
      resolve()
    }

    const timeout = setTimeout(() => {
      emit({ type: 'connect_error', error: 'timeout after 6min' })
      finish()
    }, 6 * 60 * 1000)

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

      // Wait 4 min 30s — alive TTL is 5 min, so we're cutting it close
      // The alive key was set by allowRequest, ticking down since then
      const delayMs = 4 * 60 * 1000 + 30 * 1000 // 4m30s
      await sleep(delayMs)

      if (!socket.connected) {
        emit({ type: 'scenario_done', sessionId, scenario: 'delayed-init (disconnected before init)' })
        finish()
        return
      }

      // Now send init + data right at the edge of alive expiry
      socket.emit('session_init', makeSessionInitPayload(sessionId, deviceId, config.appKey))
      emit({ type: 'init_sent', sessionId })
      await sleep(50)

      // Send one batch with vi:true — this should refresh alive if it's not expired yet
      if (batches.length > 0 && socket.connected) {
        socket.emit('session_data', batches[0])
        emit({ type: 'data_sent', bytes: batches[0].data.length, sessionId })
      }

      await sleep(1000)
      emit({ type: 'scenario_done', sessionId, scenario: 'delayed-init' })
      finish()
    })
  })
}

// ──────────────────────────────────────────────
// Scenario E: corrupt-data
// Send session_init + a buffer that is NOT valid gzip.
// Worker should fail during extractSessionData decompression.
// If it doesn't hit rollbar or tryCancel, that's a detection gap.
// ──────────────────────────────────────────────
async function scenarioCorruptData(config: WorkerConfig): Promise<void> {
  const sessionId = makeSessionId()
  const deviceId = makeDeviceId()
  const connectStart = Date.now()

  emit({ type: 'connecting' })

  return new Promise<void>((resolve) => {
    const socket: Socket = io(config.wsURL, {
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

      socket.emit('session_init', makeSessionInitPayload(sessionId, deviceId, config.appKey))
      emit({ type: 'init_sent', sessionId })
      await sleep(100)

      // Send garbage data that's NOT valid gzip
      const corruptBuffer = Buffer.from('this is not gzip data at all, just random text to break decompression')
      socket.emit('session_data', { sid: sessionId, data: corruptBuffer, vi: true })
      emit({ type: 'data_sent', bytes: corruptBuffer.length, sessionId })

      await sleep(1000)
      emit({ type: 'scenario_done', sessionId, scenario: 'corrupt-data' })
      finish()
    })
  })
}

// --- Dispatch ---

const scenarioRunners: Record<string, (config: WorkerConfig) => Promise<void>> = {
  'connect-and-vanish': scenarioConnectAndVanish,
  'init-no-data': scenarioInitNoData,
  'rapid-reconnect': scenarioRapidReconnect,
  'delayed-init': scenarioDelayedInit,
  'corrupt-data': scenarioCorruptData,
}

async function main() {
  const config = workerData as WorkerConfig
  const runner = scenarioRunners[config.scenario]

  if (!runner) {
    console.error(`Unknown scenario: ${config.scenario}`)
    process.exit(1)
  }

  for (let i = 0; i < config.connectionCount; i++) {
    runner(config)
    if (i < config.connectionCount - 1 && config.rampDelayMs > 0) {
      await sleep(config.rampDelayMs)
    }
  }

  emit({ type: 'done' })
}

main().catch((err) => {
  console.error(`[Worker ${workerData?.workerId}] Fatal:`, err)
  process.exit(1)
})
