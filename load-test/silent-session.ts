import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { appendFileSync, writeFileSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// --- CLI argument parsing ---
// npx tsx silent-session.ts --app-key KEY --connections 5 --disconnect-delay 500 --batches 1
function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].replace(/^--/, '')
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i]
      } else {
        args[key] = 'true'
      }
    }
  }
  return args
}

const args = parseArgs()

const WS_URL = args['url'] || 'wss://websdk.uxcam.com'
const APP_KEY = args['app-key']
const TOTAL_CONNECTIONS = parseInt(args['connections'] || '5', 10)
const WORKER_COUNT = Math.min(parseInt(args['workers'] || '2', 10), TOTAL_CONNECTIONS)
const RAMP_RATE = parseInt(args['ramp-rate'] || '10', 10)
const DISCONNECT_DELAY = parseInt(args['disconnect-delay'] || '500', 10)
const BATCH_COUNT = parseInt(args['batches'] || '1', 10)

if (!APP_KEY) {
  console.error('Usage: npx tsx silent-session.ts --app-key KEY [--url URL] [--connections N] [--disconnect-delay MS] [--batches N]')
  console.error('')
  console.error('  This test creates sessions that get verified and receive data,')
  console.error('  then disconnects immediately. After ~5 min the worker should')
  console.error('  pick them up. Check if they appear in upload logs / S3.')
  console.error('')
  console.error('  --connections      Number of sessions to create (default: 5)')
  console.error('  --disconnect-delay Ms to wait after last batch before disconnect (default: 500)')
  console.error('  --batches          Number of data batches to send per session (default: 1)')
  process.exit(1)
}

// --- Session tracking ---

interface TrackedSession {
  sessionId: string
  initSentAt: number
  dataBatches: number
  totalBytes: number
  disconnectedAt?: number
  abortReason?: string
}

const sessions = new Map<string, TrackedSession>()
const logFile = path.join(__dirname, `silent-session-${Date.now()}.log`)

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  appendFileSync(logFile, line + '\n')
}

// --- Metrics ---

interface Metrics {
  connecting: number
  connected: number
  connectErrors: number
  initsSent: number
  dataBatches: number
  bytesOut: number
  aborts: number
  disconnected: number
  connectLatencies: number[]
  errors: string[]
  workersFinished: number
  startTime: number
}

const m: Metrics = {
  connecting: 0,
  connected: 0,
  connectErrors: 0,
  initsSent: 0,
  dataBatches: 0,
  bytesOut: 0,
  aborts: 0,
  disconnected: 0,
  connectLatencies: [],
  errors: [],
  workersFinished: 0,
  startTime: Date.now(),
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`
  return `${(b / 1024 / 1024).toFixed(1)}MB`
}

let lastProgressLen = 0
function printProgress() {
  const elapsed = ((Date.now() - m.startTime) / 1000).toFixed(0)
  const line = `  [${elapsed}s] conn=${m.connected}/${TOTAL_CONNECTIONS} err=${m.connectErrors} init=${m.initsSent} data=${m.dataBatches} (${fmtBytes(m.bytesOut)}) aborts=${m.aborts} disc=${m.disconnected}`
  const padded = line.padEnd(lastProgressLen)
  lastProgressLen = line.length
  process.stdout.write(`\r${padded}`)
}

// --- Worker spawning ---

function spawnWorker(workerId: number, connectionCount: number, rampDelayMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'worker-silent-session.ts')
    const worker = new Worker(
      `
        const { workerData } = require('node:worker_threads');
        require('tsx');
        require('${workerPath.replace(/\\/g, '\\\\')}');
      `,
      {
        eval: true,
        workerData: {
          wsURL: WS_URL,
          appKey: APP_KEY,
          connectionCount,
          rampDelayMs,
          disconnectDelayMs: DISCONNECT_DELAY,
          batchCount: BATCH_COUNT,
          workerId,
        },
      }
    )

    worker.on('message', (msg: { type: string; [key: string]: unknown }) => {
      switch (msg.type) {
        case 'connecting': m.connecting++; break
        case 'connected':
          m.connecting = Math.max(0, m.connecting - 1)
          m.connected++
          m.connectLatencies.push(msg.latencyMs as number)
          break
        case 'connect_error':
          m.connecting = Math.max(0, m.connecting - 1)
          m.connectErrors++
          m.errors.push(`[W${workerId}] ${msg.error}`)
          break
        case 'init_sent': {
          m.initsSent++
          const sid = msg.sessionId as string
          sessions.set(sid, {
            sessionId: sid,
            initSentAt: Date.now(),
            dataBatches: 0,
            totalBytes: 0,
          })
          log(`INIT  ${sid}`)
          break
        }
        case 'data_sent': {
          m.dataBatches++
          m.bytesOut += msg.bytes as number
          const sid = msg.sessionId as string
          const s = sessions.get(sid)
          if (s) {
            s.dataBatches++
            s.totalBytes += msg.bytes as number
          }
          break
        }
        case 'session_abort': {
          m.aborts++
          const sid = msg.sessionId as string
          const s = sessions.get(sid)
          if (s) s.abortReason = msg.reason as string
          log(`ABORT ${sid} reason=${msg.reason}`)
          break
        }
        case 'disconnected': {
          m.disconnected++
          const sid = msg.sessionId as string
          const s = sessions.get(sid)
          if (s) s.disconnectedAt = Date.now()
          log(`DISC  ${sid}`)
          break
        }
        case 'done': m.workersFinished++; break
      }
    })

    worker.on('error', (err: Error) => {
      m.errors.push(`[W${workerId}] ${err.message}`)
      reject(err)
    })

    worker.on('exit', (code) => {
      if (code !== 0) m.errors.push(`[W${workerId}] exit code ${code}`)
      resolve()
    })
  })
}

// --- Main ---

async function main() {
  console.log(`\n  Silent-session test: ${TOTAL_CONNECTIONS} sessions → ${WS_URL}`)
  console.log(`  Sends init + ${BATCH_COUNT} batch(es), disconnects after ${DISCONNECT_DELAY}ms`)
  console.log(`  Sessions should be picked up by worker after ~5 min alive TTL expiry`)
  console.log(`  Log file: ${logFile}\n`)

  writeFileSync(logFile, `# Silent-session test started at ${new Date().toISOString()}\n# URL: ${WS_URL}\n# App key: ${APP_KEY}\n# Connections: ${TOTAL_CONNECTIONS}, batches: ${BATCH_COUNT}, disconnect delay: ${DISCONNECT_DELAY}ms\n\n`)

  const connectionsPerWorker = Math.floor(TOTAL_CONNECTIONS / WORKER_COUNT)
  const remainder = TOTAL_CONNECTIONS % WORKER_COUNT
  const rampDelayMs = Math.max(1, Math.floor((WORKER_COUNT / RAMP_RATE) * 1000))

  const progressInterval = setInterval(printProgress, 500)

  const workerPromises: Promise<void>[] = []
  for (let i = 0; i < WORKER_COUNT; i++) {
    const count = connectionsPerWorker + (i < remainder ? 1 : 0)
    workerPromises.push(spawnWorker(i, count, rampDelayMs))
  }

  await Promise.allSettled(workerPromises)
  clearInterval(progressInterval)

  // Final summary
  const elapsed = ((Date.now() - m.startTime) / 1000).toFixed(1)
  const p50 = percentile(m.connectLatencies, 50)
  const p95 = percentile(m.connectLatencies, 95)

  console.log(`\n\n  ── Results (${elapsed}s) ──────────────────────────`)
  console.log(`  Connected:    ${m.connected}/${TOTAL_CONNECTIONS}`)
  console.log(`  Errors:       ${m.connectErrors}`)
  console.log(`  Inits sent:   ${m.initsSent}`)
  console.log(`  Data batches: ${m.dataBatches} (${fmtBytes(m.bytesOut)})`)
  console.log(`  Aborts:       ${m.aborts}`)
  console.log(`  Latency:      p50=${p50}ms p95=${p95}ms`)

  if (m.errors.length > 0) {
    const counts = new Map<string, number>()
    for (const e of m.errors) {
      const key = e.replace(/\[W\d+\]/, '[W*]')
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    console.log(`  Errors (${m.errors.length} total):`)
    for (const [msg, count] of [...counts.entries()].slice(0, 5)) {
      console.log(`    ${count}x ${msg}`)
    }
  }

  // Print session IDs for verification
  console.log(`\n  ── Session IDs to verify ──────────────────────────`)
  console.log(`  Check these in Redis / PG upload_log / S3 after ~5-6 min:`)
  console.log('')
  for (const [sid, s] of sessions) {
    const status = s.abortReason ? `ABORTED(${s.abortReason})` : `OK(${s.dataBatches} batches, ${fmtBytes(s.totalBytes)})`
    console.log(`  ${sid}  ${status}`)
    log(`SUMMARY ${sid} ${status}`)
  }

  console.log(`\n  Log saved to: ${logFile}`)
  console.log(`\n  Next steps:`)
  console.log(`    1. Wait ~6 minutes for alive TTL to expire + worker cycle`)
  console.log(`    2. Check PG: SELECT * FROM upload_log WHERE session_id IN (...)`)
  console.log(`    3. Check Redis: EXISTS <sid>:processed`)
  console.log(`    4. If any session is missing from upload_log AND has no rollbar/tryCancel, that's the bug`)
  console.log('')

  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
