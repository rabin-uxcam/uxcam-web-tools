import { parentPort, workerData } from 'node:worker_threads'
import { io, type Socket } from 'socket.io-client'
import {
  makeSessionId,
  makeDeviceId,
  makeSessionInitPayload,
  buildSessionBatches,
} from './payloads.js'

/**
 * Silent-session test worker
 *
 * Goal: create sessions that ARE verified and have data, but might silently
 * fail to upload without triggering tryCancel or rollbar.
 *
 * The session lifecycle:
 *   1. Connect (allowRequest verifies → sets config, alive, started)
 *   2. Send session_init (sets initData, refreshes alive)
 *   3. Send exactly 1 small data batch with vi:true (pushes binData, refreshes alive)
 *   4. Immediately disconnect — no pings, no further data
 *   5. alive key expires after 5 min
 *   6. Worker should pick up the session and upload it
 *
 * If the session never appears in the upload log / S3, we've found the bug.
 * The session IDs are logged so you can check Redis / PG / S3 afterwards.
 */

interface WorkerConfig {
  wsURL: string
  appKey: string
  connectionCount: number
  rampDelayMs: number
  workerId: number
  disconnectDelayMs: number
  batchCount: number
}

type MetricEvent =
  | { type: 'connecting' }
  | { type: 'connected'; latencyMs: number }
  | { type: 'connect_error'; error: string }
  | { type: 'init_sent'; sessionId: string }
  | { type: 'data_sent'; bytes: number; sessionId: string }
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

  // Build minimal batches — just enough to have data
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

    socket.on('connect_error', (err: Error & { description?: unknown; context?: unknown; data?: unknown; type?: string }) => {
      clearTimeout(timeout)
      const parts = [err.message]
      for (const key of ['description', 'data', 'context', 'type'] as const) {
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

        // 2. Send minimal data batches (just enough to not be "empty")
        for (let i = 0; i < batchesToSend.length; i++) {
          if (!socket.connected) break
          socket.emit('session_data', batchesToSend[i])
          emit({ type: 'data_sent', bytes: batchesToSend[i].data.length, sessionId })
          if (i < batchesToSend.length - 1) {
            await sleep(200)
          }
        }

        // 3. Wait briefly then disconnect — no pings, no further interaction
        //    The alive key (5 min TTL) will expire on its own.
        //    The worker should then pick up and upload this session.
        await sleep(config.disconnectDelayMs)
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
