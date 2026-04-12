import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Corrupt-chunks load test
 *
 * Tests that extractSessionData and shrinkSessionData correctly handle
 * corrupted gzip chunks without infinite retry loops.
 *
 * Usage:
 *   npx tsx corrupt-chunks.ts --app-key KEY [--scenario SCENARIO] [--connections N] [--url URL]
 *
 * Scenarios:
 *   mixed-chunks     — Valid chunks + corrupted chunk interleaved. Backend should
 *                       skip corrupted, process valid ones, and upload successfully.
 *
 *   all-corrupted    — Only corrupted chunks (no valid data). Backend should trigger
 *                       "All chunks corrupted" cancellation (reason 3).
 *
 *   truncated-gzip   — Valid gzip header (1f 8b) but truncated body. This is the
 *                       exact error pattern from production ("unexpected end of file").
 *
 *   all              — Run all scenarios (default)
 *
 * What to verify in backend logs:
 *   mixed-chunks:   "Session data decompression error ... skipped: 1" then successful upload
 *   all-corrupted:  "All chunks corrupted" → tryCancelSession with reason 3
 *   truncated-gzip: Same as mixed-chunks — truncated chunk skipped, valid ones uploaded
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
const CONNECTIONS_PER_SCENARIO = parseInt(args['connections'] || '2', 10)
const SCENARIO = args['scenario'] || 'all'

const ALL_SCENARIOS = ['mixed-chunks', 'all-corrupted', 'truncated-gzip'] as const
const scenarios = SCENARIO === 'all' ? [...ALL_SCENARIOS] : [SCENARIO]

if (!APP_KEY) {
  console.error('Usage: npx tsx corrupt-chunks.ts --app-key KEY [--scenario SCENARIO] [--connections N] [--url URL]')
  console.error('')
  console.error('Scenarios: mixed-chunks | all-corrupted | truncated-gzip | all')
  console.error('')
  console.error('  mixed-chunks    Send valid + corrupted chunks. Backend should skip bad')
  console.error('                  chunks and upload the session with valid data.')
  console.error('')
  console.error('  all-corrupted   Send only corrupted chunks. Backend should cancel the')
  console.error('                  session with "All chunks corrupted" (reason 3).')
  console.error('')
  console.error('  truncated-gzip  Send valid chunks + a truncated gzip (has 1f 8b header')
  console.error('                  but body is cut short). Reproduces the production')
  console.error('                  "unexpected end of file" error exactly.')
  process.exit(1)
}

// --- Tracking ---

interface TrackedSession {
  sessionId: string
  scenario: string
  events: string[]
  startTime: number
}

const tracked = new Map<string, TrackedSession>()

type WorkerEvent =
  | { type: 'connecting' }
  | { type: 'connected'; latencyMs: number }
  | { type: 'connect_error'; error: string }
  | { type: 'init_sent'; sessionId: string }
  | { type: 'data_sent'; bytes: number; sessionId: string; label: string }
  | { type: 'session_abort'; reason: string; sessionId: string }
  | { type: 'disconnected'; sessionId: string }
  | { type: 'scenario_done'; sessionId: string; scenario: string }
  | { type: 'done' }

const metrics = {
  connected: 0,
  connectErrors: 0,
  initsSent: 0,
  dataBatches: 0,
  bytesOut: 0,
  aborts: 0,
  disconnected: 0,
  scenariosDone: 0,
  workersFinished: 0,
  startTime: Date.now(),
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`
  return `${(b / 1024 / 1024).toFixed(1)}MB`
}

function handleEvent(msg: WorkerEvent) {
  switch (msg.type) {
    case 'connected': metrics.connected++; break
    case 'connect_error': metrics.connectErrors++; break
    case 'init_sent':
      metrics.initsSent++
      tracked.get(msg.sessionId)?.events.push('init_sent')
      break
    case 'data_sent':
      metrics.dataBatches++
      metrics.bytesOut += msg.bytes
      tracked.get(msg.sessionId)?.events.push(`data: ${msg.label} (${fmtBytes(msg.bytes)})`)
      break
    case 'session_abort':
      metrics.aborts++
      tracked.get(msg.sessionId)?.events.push(`abort: ${msg.reason}`)
      break
    case 'disconnected':
      metrics.disconnected++
      break
    case 'scenario_done':
      metrics.scenariosDone++
      tracked.get(msg.sessionId)?.events.push('done')
      break
    case 'done':
      metrics.workersFinished++
      break
  }
}

// --- Worker spawning ---

function spawnWorker(
  scenario: string,
  connectionCount: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'worker-corrupt-chunks.ts')
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
          scenario,
        },
      }
    )

    worker.on('message', (msg: WorkerEvent) => {
      // Track sessions when init is sent
      if (msg.type === 'init_sent' && msg.sessionId) {
        tracked.set(msg.sessionId, {
          sessionId: msg.sessionId,
          scenario,
          events: ['connected'],
          startTime: Date.now(),
        })
      }
      handleEvent(msg)
    })

    worker.on('error', reject)
    worker.on('exit', () => resolve())
  })
}

// --- Main ---

async function main() {
  const totalConnections = scenarios.length * CONNECTIONS_PER_SCENARIO

  console.log(`\n  Corrupt-chunks test: ${totalConnections} sessions → ${WS_URL}`)
  console.log(`  Scenarios: ${scenarios.join(', ')} (${CONNECTIONS_PER_SCENARIO} each)\n`)

  const workerPromises: Promise<void>[] = []

  for (const scenario of scenarios) {
    workerPromises.push(spawnWorker(scenario, CONNECTIONS_PER_SCENARIO))
  }

  await Promise.allSettled(workerPromises)

  // Wait a moment for any straggling events
  await new Promise((r) => setTimeout(r, 500))

  // --- Results ---
  const elapsed = ((Date.now() - metrics.startTime) / 1000).toFixed(1)

  console.log(`\n  ── Results (${elapsed}s) ──────────────────────────`)
  console.log(`  Connected:      ${metrics.connected}/${totalConnections}`)
  console.log(`  Errors:         ${metrics.connectErrors}`)
  console.log(`  Inits sent:     ${metrics.initsSent}`)
  console.log(`  Data batches:   ${metrics.dataBatches} (${fmtBytes(metrics.bytesOut)})`)
  console.log(`  Aborts:         ${metrics.aborts}`)
  console.log(`  Scenarios done: ${metrics.scenariosDone}/${totalConnections}`)

  console.log(`\n  ── Session details ──────────────────────────`)
  for (const [sid, t] of tracked) {
    const dur = ((Date.now() - t.startTime) / 1000).toFixed(1)
    console.log(`  [${t.scenario}] ${sid} (${dur}s)`)
    for (const e of t.events) {
      console.log(`    → ${e}`)
    }
  }

  console.log(`\n  ── What to check in backend logs ──────────────`)
  console.log(`  mixed-chunks:   Look for "skipped: 1" then successful upload for the session`)
  console.log(`  all-corrupted:  Look for "All chunks corrupted" → tryCancelSession reason 3`)
  console.log(`  truncated-gzip: Look for "skipped: 1" (truncated gzip skipped, valid uploaded)`)
  console.log('')

  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
