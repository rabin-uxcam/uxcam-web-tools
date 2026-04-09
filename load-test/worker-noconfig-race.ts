import { parentPort, workerData } from 'node:worker_threads'
import { io, type Socket } from 'socket.io-client'
import {
  makeSessionId,
  makeDeviceId,
  makeSessionInitPayload,
  buildSessionBatches,
} from './payloads.js'

/**
 * noconfig-race test worker
 *
 * Reproduces the TOCTOU race condition where a verified session with data
 * gets its config deleted (via session_abort) right before the session worker
 * tries to read it, causing "Session config not found".
 *
 * The lifecycle:
 *   1. Connect (allowRequest verifies → sets config, alive, started)
 *   2. Send session_init (sets initData)
 *   3. Send 1 data batch (pushes binData)
 *   4. Immediately emit session_abort → deleteSession wipes config
 *   5. Disconnect
 *   6. alive key is already deleted by deleteSession
 *   7. Worker finds session in started list (if listRemove races),
 *      sees !isAlive, hasInitData=true, hasConfig=false → ERROR
 *
 * The abort-delay parameter controls how long to wait after the last data
 * batch before emitting session_abort. Shorter = tighter race window.
 */

interface WorkerConfig {
  wsURL: string
  appKey: string
  connectionCount: number
  rampDelayMs: number
  workerId: number
  abortDelayMs: number
  batchCount: number
}

type MetricEvent =
  | { type: 'connecting' }
  | { type: 'connected'; latencyMs: number }
  | { type: 'connect_error'; error: string }
  | { type: 'init_sent'; sessionId: string }
  | { type: 'data_sent'; bytes: number; sessionId: string }
  | { type: 'abort_sent'; sessionId: string }
  | { type: 'session_abort'; reason: string; sessionId: string }
  | { type: 'disconnected'; sessionId: string }
  | { type: 'done' }

function emit(event: MetricEvent) {
  parentPort?.postMessage(event)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runConnection(config: WorkerConfig): Promise<void> {
  const sessionId = makeSessionId()
  const deviceId = makeDeviceId()
  const connectStart = Date.now()

  const batches = buildSessionBatches(sessionId, 10)
  const batchesToSend = batches.slice(0, config.batchCount)

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

    socket.on('connect_error', (err: Error & { description?: unknown; data?: unknown }) => {
      clearTimeout(timeout)
      const parts = [err.message]
      for (const key of ['description', 'data'] as const) {
        const val = (err as Record<string, unknown>)[key]
        if (val !== undefined) {
          parts.push(`${key}=${typeof val === 'object' ? JSON.stringify(val) : String(val)}`)
        }
      }
      emit({ type: 'connect_error', error: parts.join(' | ') })
      finish()
    })

    socket.on('session_abort', (reason: string) => {
      emit({ type: 'session_abort', reason, sessionId })
    })

    socket.on('kill', () => {
      emit({ type: 'session_abort', reason: 'killed', sessionId })
      clearTimeout(timeout)
      finish()
    })

    socket.on('disconnect', () => {
      clearTimeout(timeout)
      finish()
    })

    socket.on('connect', async () => {
      clearTimeout(timeout)
      emit({ type: 'connected', latencyMs: Date.now() - connectStart })

      try {
        // 1. Send session_init
        socket.emit('session_init', makeSessionInitPayload(sessionId, deviceId, config.appKey))
        emit({ type: 'init_sent', sessionId })

        await sleep(100)

        // 2. Send data batches
        for (let i = 0; i < batchesToSend.length; i++) {
          if (!socket.connected) break
          socket.emit('session_data', batchesToSend[i])
          emit({ type: 'data_sent', bytes: batchesToSend[i].data.length, sessionId })
          if (i < batchesToSend.length - 1) {
            await sleep(200)
          }
        }

        // 3. Wait the abort delay, then emit session_abort
        //    This triggers handleSessionAbort → deleteSession → wipes config
        //    The session is still in the 'started' list momentarily (race window)
        await sleep(config.abortDelayMs)

        if (socket.connected) {
          socket.emit('session_abort', sessionId)
          emit({ type: 'abort_sent', sessionId })
        }

        // 4. Brief pause to let the abort propagate, then disconnect
        await sleep(200)
        finish()
      } catch (err) {
        emit({ type: 'connect_error', error: String(err) })
        finish()
      }
    })
  })
}

// --- Worker main ---

async function main() {
  const config = workerData as WorkerConfig

  for (let i = 0; i < config.connectionCount; i++) {
    runConnection(config)
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
