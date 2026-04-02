import { parentPort, workerData } from 'node:worker_threads'
import { io, type Socket } from 'socket.io-client'
import {
  makeSessionId,
  makeDeviceId,
  makeSessionInitPayload,
  buildSessionBatches,
} from './payloads.js'

interface WorkerConfig {
  wsURL: string
  appKey: string
  connectionCount: number
  rampDelayMs: number
  batchIntervalMs: number
  sendPings: boolean
  workerId: number
}

type MetricEvent =
  | { type: 'connecting' }
  | { type: 'connected'; latencyMs: number }
  | { type: 'connect_error'; error: string }
  | { type: 'init_sent' }
  | { type: 'data_sent'; bytes: number }
  | { type: 'ping_sent' }
  | { type: 'ping_ack'; alive: boolean }
  | { type: 'session_abort'; reason: string }
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

  // Pre-build all batches from test.json (batch 0 = page load, rest = subsequent)
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
      emit({ type: 'session_abort', reason })
    })

    socket.on('kill', () => {
      emit({ type: 'session_abort', reason: 'killed (50MB limit)' })
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
        // 1. session_init
        socket.emit('session_init', makeSessionInitPayload(sessionId, deviceId, config.appKey))
        emit({ type: 'init_sent' })

        await sleep(100)

        // 2. Send batches: batch 0 = page load first, then subsequent changes
        for (let i = 0; i < batches.length; i++) {
          if (!socket.connected) break
          socket.emit('session_data', batches[i])
          emit({ type: 'data_sent', bytes: batches[i].data.length })
          if (i < batches.length - 1) {
            await sleep(config.batchIntervalMs)
          }
        }

        // 3. Optional pings
        if (config.sendPings) {
          for (let i = 0; i < 2; i++) {
            await sleep(2000)
            if (!socket.connected) break
            socket.emit('session_ping', { sid: sessionId }, (response: { alive: boolean }) => {
              emit({ type: 'ping_ack', alive: response?.alive ?? false })
            })
            emit({ type: 'ping_sent' })
          }
        }

        await sleep(1000)
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
