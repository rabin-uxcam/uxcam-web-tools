import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// --- CLI argument parsing ---
// npx tsx connect-only.ts --app-key [APPKEY] --connections 100 --hold 30000
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
const TOTAL_CONNECTIONS = parseInt(args['connections'] || '100', 10)
const WORKER_COUNT = Math.min(parseInt(args['workers'] || '4', 10), TOTAL_CONNECTIONS)
const RAMP_RATE = parseInt(args['ramp-rate'] || '50', 10)
const HOLD_DURATION = parseInt(args['hold'] || '30000', 10)
const SEND_PINGS = args['no-pings'] !== 'true'

if (!APP_KEY) {
  console.error('Usage: npx tsx connect-only.ts --app-key KEY [--url URL] [--connections N] [--workers N] [--ramp-rate N] [--hold MS] [--no-pings]')
  process.exit(1)
}

// --- Metrics ---

interface Metrics {
  connecting: number
  connected: number
  connectErrors: number
  initsSent: number
  pingsSent: number
  pingsAlive: number
  pingsDead: number
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
  pingsSent: 0,
  pingsAlive: 0,
  pingsDead: 0,
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

// One-liner progress on same line
let lastProgressLen = 0
function printProgress() {
  const elapsed = ((Date.now() - m.startTime) / 1000).toFixed(0)
  const line = `  [${elapsed}s] conn=${m.connected}/${TOTAL_CONNECTIONS} err=${m.connectErrors} init=${m.initsSent} pings=${m.pingsSent} disc=${m.disconnected}`
  const padded = line.padEnd(lastProgressLen)
  lastProgressLen = line.length
  process.stdout.write(`\r${padded}`)
}

// --- Worker spawning ---

function spawnWorker(workerId: number, connectionCount: number, rampDelayMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'worker-connect-only.ts')
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
          holdDurationMs: HOLD_DURATION,
          sendPings: SEND_PINGS,
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
        case 'init_sent': m.initsSent++; break
        case 'ping_sent': m.pingsSent++; break
        case 'ping_ack': msg.alive ? m.pingsAlive++ : m.pingsDead++; break
        case 'session_abort': m.aborts++; break
        case 'disconnected': m.disconnected++; break
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
  console.log(`\n  Connect-only load test: ${TOTAL_CONNECTIONS} connections → ${WS_URL} (key=${APP_KEY})`)
  console.log(`  ${WORKER_COUNT} workers, ${RAMP_RATE}/s ramp, hold=${HOLD_DURATION}ms, NO DATA SENT\n`)

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
  const p99 = percentile(m.connectLatencies, 99)

  console.log(`\n\n  ── Results (${elapsed}s) ──────────────────────────`)
  console.log(`  Connected:    ${m.connected}/${TOTAL_CONNECTIONS}`)
  console.log(`  Errors:       ${m.connectErrors}${m.connectErrors ? ` (${((m.connectErrors / TOTAL_CONNECTIONS) * 100).toFixed(1)}%)` : ''}`)
  console.log(`  Inits sent:   ${m.initsSent}`)
  console.log(`  Data sent:    0 (connect-only mode)`)
  console.log(`  Pings:        ${m.pingsSent} sent, ${m.pingsAlive} alive, ${m.pingsDead} dead`)
  console.log(`  Aborts:       ${m.aborts}`)
  console.log(`  Latency:      p50=${p50}ms p95=${p95}ms p99=${p99}ms`)

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
  console.log('')

  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
