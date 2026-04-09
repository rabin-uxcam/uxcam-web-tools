import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { appendFileSync, writeFileSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * noconfig-race test
 *
 * Reproduces the "Session config not found" error that occurs when a recently
 * verified session is aborted before the session worker reads its config.
 *
 * The race condition:
 *   1. Session connects → allowRequest verifies → config saved to Redis
 *   2. Client sends session_init + data (initData + binData exist)
 *   3. Client emits session_abort → handleSessionAbort → deleteSession()
 *      - Deletes config, initData, alive, removes from started list
 *   4. Session worker was already iterating the started list
 *      - exists(config) returned true BEFORE the abort
 *      - get(config) returns null AFTER the abort deleted it
 *      - THROWS "Session config not found"
 *
 * Usage:
 *   npx tsx noconfig-race.ts --app-key KEY [--connections N] [--abort-delay MS] [--url URL]
 *
 * Options:
 *   --connections    Number of sessions to create (default: 10)
 *   --abort-delay    Ms to wait after last data batch before aborting (default: 50)
 *                    Lower = tighter race. Try 0, 50, 200, 500.
 *   --batches        Data batches to send before aborting (default: 1)
 *   --workers        Number of parallel workers (default: 2)
 *   --ramp-rate      Connections per second (default: 10)
 *   --url            WebSocket URL (default: wss://websdk.uxcam.com)
 */

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
const TOTAL_CONNECTIONS = parseInt(args['connections'] || '10', 10)
const WORKER_COUNT = Math.min(parseInt(args['workers'] || '2', 10), TOTAL_CONNECTIONS)
const RAMP_RATE = parseInt(args['ramp-rate'] || '10', 10)
const ABORT_DELAY = parseInt(args['abort-delay'] || '50', 10)
const BATCH_COUNT = parseInt(args['batches'] || '1', 10)

if (!APP_KEY) {
  console.error('Usage: npx tsx noconfig-race.ts --app-key KEY [--connections N] [--abort-delay MS]')
  console.error('')
  console.error('  Reproduces the "Session config not found" TOCTOU race condition.')
  console.error('  Creates sessions that verify + send data, then immediately abort.')
  console.error('  The abort deletes the config key from Redis while the session')
  console.error('  worker may still be trying to process the session.')
  console.error('')
  console.error('  --connections    Sessions to create (default: 10)')
  console.error('  --abort-delay    Ms after last data batch before abort (default: 50)')
  console.error('                   Use 0 for tightest race, 500+ for wider window')
  console.error('  --batches        Data batches per session (default: 1)')
  console.error('  --workers        Parallel workers (default: 2)')
  console.error('  --url            WebSocket URL (default: wss://websdk.uxcam.com)')
  process.exit(1)
}

// --- Session tracking ---

interface TrackedSession {
  sessionId: string
  initSentAt?: number
  dataBatches: number
  totalBytes: number
  abortSentAt?: number
  abortResponse?: string
  disconnectedAt?: number
}

const sessions = new Map<string, TrackedSession>()
const logFile = path.join(__dirname, `noconfig-race-${Date.now()}.log`)

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(`  ${line}`)
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
  abortsSent: number
  abortResponses: number
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
  abortsSent: 0,
  abortResponses: 0,
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
  const line = `  [${elapsed}s] conn=${m.connected}/${TOTAL_CONNECTIONS} err=${m.connectErrors} init=${m.initsSent} data=${m.dataBatches} aborts=${m.abortsSent}/${m.abortResponses} disc=${m.disconnected}`
  const padded = line.padEnd(lastProgressLen)
  lastProgressLen = line.length
  process.stdout.write(`\r${padded}`)
}

// --- Worker spawning ---

function spawnWorker(workerId: number, connectionCount: number, rampDelayMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'worker-noconfig-race.ts')
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
          abortDelayMs: ABORT_DELAY,
          batchCount: BATCH_COUNT,
          workerId,
        },
      }
    )

    worker.on('message', (msg: { type: string; [key: string]: unknown }) => {
      const sid = msg.sessionId as string | undefined

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
          if (sid) {
            sessions.set(sid, {
              sessionId: sid,
              initSentAt: Date.now(),
              dataBatches: 0,
              totalBytes: 0,
            })
          }
          log(`INIT  ${sid}`)
          break
        }
        case 'data_sent': {
          m.dataBatches++
          m.bytesOut += msg.bytes as number
          if (sid) {
            const s = sessions.get(sid)
            if (s) {
              s.dataBatches++
              s.totalBytes += msg.bytes as number
            }
          }
          break
        }
        case 'abort_sent': {
          m.abortsSent++
          if (sid) {
            const s = sessions.get(sid)
            if (s) s.abortSentAt = Date.now()
          }
          log(`ABORT ${sid} (client-initiated, delay=${ABORT_DELAY}ms)`)
          break
        }
        case 'session_abort': {
          m.abortResponses++
          if (sid) {
            const s = sessions.get(sid)
            if (s) s.abortResponse = msg.reason as string
          }
          log(`ABORT_ACK ${sid} reason=${msg.reason}`)
          break
        }
        case 'disconnected': {
          m.disconnected++
          if (sid) {
            const s = sessions.get(sid)
            if (s) s.disconnectedAt = Date.now()
          }
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
  console.log(`\n  noconfig-race test: ${TOTAL_CONNECTIONS} sessions → ${WS_URL}`)
  console.log(`  Sends init + ${BATCH_COUNT} batch(es), then aborts after ${ABORT_DELAY}ms`)
  console.log(`  This triggers deleteSession which removes config from Redis`)
  console.log(`  If the worker reads config after deletion → "Session config not found"`)
  console.log(`  Log file: ${logFile}\n`)

  writeFileSync(logFile, [
    `# noconfig-race test started at ${new Date().toISOString()}`,
    `# URL: ${WS_URL}`,
    `# App key: ${APP_KEY}`,
    `# Connections: ${TOTAL_CONNECTIONS}, batches: ${BATCH_COUNT}, abort delay: ${ABORT_DELAY}ms`,
    '',
    '',
  ].join('\n'))

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
  console.log(`  Connected:      ${m.connected}/${TOTAL_CONNECTIONS}`)
  console.log(`  Errors:         ${m.connectErrors}`)
  console.log(`  Inits sent:     ${m.initsSent}`)
  console.log(`  Data batches:   ${m.dataBatches} (${fmtBytes(m.bytesOut)})`)
  console.log(`  Aborts sent:    ${m.abortsSent}`)
  console.log(`  Abort acks:     ${m.abortResponses}`)
  console.log(`  Latency:        p50=${p50}ms p95=${p95}ms`)

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
  console.log(`\n  ── Session IDs ──────────────────────────`)
  console.log(`  Check server logs for "Session config not found" or "Session missing data"`)
  console.log(`  matching these session IDs:\n`)

  for (const [sid, s] of sessions) {
    const abortAck = s.abortResponse ? `ack=${s.abortResponse}` : 'no-ack'
    const timing = s.abortSentAt && s.initSentAt
      ? `abort ${s.abortSentAt - s.initSentAt}ms after init`
      : ''
    console.log(`  ${sid}  ${s.dataBatches} batches, ${fmtBytes(s.totalBytes)}, ${abortAck} ${timing}`)
    log(`SUMMARY ${sid} batches=${s.dataBatches} bytes=${s.totalBytes} ${abortAck} ${timing}`)
  }

  console.log(`\n  ── What to look for ──────────────────────────`)
  console.log('')
  console.log(`  In server logs (within ~6 min):`)
  console.log(`    - "Session missing data session: <sid> hasInitData: true hasConfig: false"`)
  console.log(`    - "Session config not found"`)
  console.log(`    - These confirm the TOCTOU race between abort and worker`)
  console.log('')
  console.log(`  In Redis:`)
  console.log(`    - Sessions should be fully cleaned up (deleteSession ran)`)
  console.log(`    - But if the worker errors BEFORE cleanup, keys may linger:`)
  console.log(`      redis-cli EXISTS "uxcam-web-sdk:<sid>:config"`)
  console.log(`      redis-cli EXISTS "uxcam-web-sdk:<sid>:initData"`)
  console.log(`      redis-cli LPOS uxcam-web-sdk:started '"<sid>"'`)
  console.log('')
  console.log(`  Tuning:`)
  console.log(`    - --abort-delay 0    Tightest race (abort fires immediately after data)`)
  console.log(`    - --abort-delay 500  Wider window (more realistic tab-close timing)`)
  console.log(`    - --connections 50   More sessions = higher chance of hitting the race`)
  console.log('')
  console.log(`  Log saved to: ${logFile}`)
  console.log('')

  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
