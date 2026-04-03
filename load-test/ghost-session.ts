import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { appendFileSync, writeFileSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Ghost-session test
 *
 * Runs multiple scenarios that could cause sessions to be verified but silently
 * never upload, without triggering tryCancel or rollbar.
 *
 * Usage:
 *   npx tsx ghost-session.ts --app-key KEY [--scenario SCENARIO] [--connections N] [--url URL]
 *
 * Scenarios:
 *   connect-and-vanish  — Verified but no session_init sent (most likely silent failure)
 *   init-no-data        — session_init sent but no data (should trigger tryCancel)
 *   rapid-reconnect     — Two connections for same session ID in quick succession
 *   delayed-init        — Wait ~4.5 min before sending init (race with alive expiry)
 *   corrupt-data        — Send non-gzip buffer as session_data
 *   all                 — Run all scenarios (default)
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
const CONNECTIONS_PER_SCENARIO = parseInt(args['connections'] || '3', 10)
const RAMP_RATE = parseInt(args['ramp-rate'] || '5', 10)
const SCENARIO = args['scenario'] || 'all'

const ALL_SCENARIOS = ['connect-and-vanish', 'init-no-data', 'rapid-reconnect', 'delayed-init', 'corrupt-data'] as const
const scenarios = SCENARIO === 'all' ? [...ALL_SCENARIOS] : [SCENARIO]

if (!APP_KEY) {
  console.error('Usage: npx tsx ghost-session.ts --app-key KEY [--scenario SCENARIO] [--connections N]')
  console.error('')
  console.error('Scenarios: connect-and-vanish | init-no-data | rapid-reconnect | delayed-init | corrupt-data | all')
  console.error('')
  console.error('  connect-and-vanish  Verified (allowRequest passes) but session_init never sent.')
  console.error('                      Worker sees no initData → silently skips. Session stays in')
  console.error('                      started list forever. MOST LIKELY SILENT FAILURE PATH.')
  console.error('')
  console.error('  init-no-data        session_init sent, no session_data. Should trigger tryCancel')
  console.error('                      with "Empty screen timeline". Control test.')
  console.error('')
  console.error('  rapid-reconnect     Connect → init → 1 batch → disconnect → reconnect → more data.')
  console.error('                      Tests data continuity across reconnections.')
  console.error('')
  console.error('  delayed-init        Wait 4m30s after connect before sending init + data.')
  console.error('                      Tests race with 5-min alive TTL expiry.')
  console.error('')
  console.error('  corrupt-data        Send non-gzip buffer. Tests decompression error handling.')
  process.exit(1)
}

// --- Tracking ---

interface TrackedSession {
  sessionId: string
  scenario: string
  events: string[]
  startedAt: number
}

const sessions = new Map<string, TrackedSession>()
const logFile = path.join(__dirname, `ghost-session-${Date.now()}.log`)

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(`  ${line}`)
  appendFileSync(logFile, line + '\n')
}

// --- Metrics ---

const m = {
  connected: 0,
  connectErrors: 0,
  initsSent: 0,
  dataBatches: 0,
  bytesOut: 0,
  aborts: 0,
  disconnected: 0,
  scenariosDone: 0,
  errors: [] as string[],
  startTime: Date.now(),
}

// --- Worker spawning ---

function spawnScenarioWorker(scenario: string, connectionCount: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'worker-ghost-session.ts')
    const rampDelayMs = Math.max(1, Math.floor(1000 / RAMP_RATE))

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
          workerId: 0,
          scenario,
        },
      }
    )

    worker.on('message', (msg: { type: string; [key: string]: unknown }) => {
      const sid = msg.sessionId as string | undefined

      switch (msg.type) {
        case 'connecting': break
        case 'connected':
          m.connected++
          break
        case 'connect_error':
          m.connectErrors++
          m.errors.push(`[${scenario}] ${msg.error}`)
          break
        case 'init_sent':
          m.initsSent++
          if (sid) {
            const s = sessions.get(sid) || { sessionId: sid, scenario, events: [], startedAt: Date.now() }
            s.events.push('init_sent')
            sessions.set(sid, s)
          }
          log(`INIT  [${scenario}] ${sid}`)
          break
        case 'data_sent':
          m.dataBatches++
          m.bytesOut += msg.bytes as number
          if (sid) sessions.get(sid)?.events.push(`data_sent(${msg.bytes}B)`)
          break
        case 'session_abort':
          m.aborts++
          if (sid) sessions.get(sid)?.events.push(`abort(${msg.reason})`)
          log(`ABORT [${scenario}] ${sid} reason=${msg.reason}`)
          break
        case 'disconnected':
          m.disconnected++
          if (sid) sessions.get(sid)?.events.push('disconnected')
          break
        case 'scenario_done':
          m.scenariosDone++
          if (sid) {
            const s = sessions.get(sid) || { sessionId: sid, scenario: msg.scenario as string, events: [], startedAt: Date.now() }
            s.events.push('done')
            if (!sessions.has(sid)) sessions.set(sid, s)
          }
          log(`DONE  [${msg.scenario}] ${sid}`)
          break
        case 'done': break
      }
    })

    worker.on('error', (err: Error) => {
      m.errors.push(`[${scenario}] worker error: ${err.message}`)
      reject(err)
    })

    worker.on('exit', (code) => {
      if (code !== 0) m.errors.push(`[${scenario}] worker exit code ${code}`)
      resolve()
    })
  })
}

// --- Main ---

async function main() {
  const hasDelayed = scenarios.includes('delayed-init')

  console.log(`\n  Ghost-session test → ${WS_URL} (key=${APP_KEY})`)
  console.log(`  Scenarios: ${scenarios.join(', ')}`)
  console.log(`  ${CONNECTIONS_PER_SCENARIO} session(s) per scenario`)
  if (hasDelayed) {
    console.log(`  ⚠ delayed-init scenario takes ~5 min to complete`)
  }
  console.log(`  Log file: ${logFile}\n`)

  writeFileSync(logFile, [
    `# Ghost-session test started at ${new Date().toISOString()}`,
    `# URL: ${WS_URL}`,
    `# App key: ${APP_KEY}`,
    `# Scenarios: ${scenarios.join(', ')}`,
    `# Connections per scenario: ${CONNECTIONS_PER_SCENARIO}`,
    '',
    '',
  ].join('\n'))

  const workerPromises: Promise<void>[] = []
  for (const scenario of scenarios) {
    workerPromises.push(spawnScenarioWorker(scenario, CONNECTIONS_PER_SCENARIO))
  }

  await Promise.allSettled(workerPromises)

  const elapsed = ((Date.now() - m.startTime) / 1000).toFixed(1)

  console.log(`\n  ── Results (${elapsed}s) ──────────────────────────`)
  console.log(`  Connected:     ${m.connected}`)
  console.log(`  Connect errors:${m.connectErrors}`)
  console.log(`  Inits sent:    ${m.initsSent}`)
  console.log(`  Data batches:  ${m.dataBatches}`)
  console.log(`  Aborts:        ${m.aborts}`)
  console.log(`  Scenarios done:${m.scenariosDone}`)

  if (m.errors.length > 0) {
    const counts = new Map<string, number>()
    for (const e of m.errors) counts.set(e, (counts.get(e) || 0) + 1)
    console.log(`\n  Errors (${m.errors.length} total):`)
    for (const [msg, count] of [...counts.entries()].slice(0, 10)) {
      console.log(`    ${count}x ${msg}`)
    }
  }

  // Print session tracking
  console.log(`\n  ── Sessions to verify ──────────────────────────`)
  console.log(`  After ~6 min, check these session IDs:\n`)

  const byScenario = new Map<string, TrackedSession[]>()
  for (const s of sessions.values()) {
    const list = byScenario.get(s.scenario) || []
    list.push(s)
    byScenario.set(s.scenario, list)
  }

  for (const [scenario, sessList] of byScenario) {
    console.log(`  [${scenario}]`)
    for (const s of sessList) {
      console.log(`    ${s.sessionId}  events: ${s.events.join(' → ')}`)
      log(`SUMMARY [${scenario}] ${s.sessionId} events: ${s.events.join(' → ')}`)
    }
    console.log('')
  }

  console.log(`  ── What to check ──────────────────────────`)
  console.log('')
  console.log(`  connect-and-vanish sessions:`)
  console.log(`    - Should have config + alive in Redis (alive expires after 5 min)`)
  console.log(`    - Should NOT have initData or binData`)
  console.log(`    - Worker should silently skip (no rollbar, no tryCancel)`)
  console.log(`    - Session stays in "started" list FOREVER — this is the leak`)
  console.log(`    → Check: redis-cli LPOS uxcam-web-sdk:started '"<sid>"'`)
  console.log('')
  console.log(`  init-no-data sessions:`)
  console.log(`    - Should trigger "Empty screen timeline" → tryCancel`)
  console.log(`    - If NOT in rollbar/tryCancel logs, that's a detection gap`)
  console.log('')
  console.log(`  rapid-reconnect sessions:`)
  console.log(`    - Check if upload contains data from BOTH connections`)
  console.log(`    - Missing data = reconnection race condition`)
  console.log('')
  console.log(`  delayed-init sessions:`)
  console.log(`    - If abort received: alive expired before init (expected)`)
  console.log(`    - If no abort: data was accepted right at TTL edge`)
  console.log(`    - Check if session uploaded or silently dropped`)
  console.log('')
  console.log(`  corrupt-data sessions:`)
  console.log(`    - Should trigger decompression error → rollbar`)
  console.log(`    - If NOT in rollbar, that's a detection gap`)
  console.log('')
  console.log(`  Log saved to: ${logFile}`)
  console.log('')

  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
