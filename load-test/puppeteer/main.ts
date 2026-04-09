import puppeteer, { Browser, Page } from 'puppeteer'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── CLI args ──────────────────────────────────────────────
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

const APP_KEY       = args['app-key']
const SDK_URL       = args['sdk-url'] || ''         // URL to SDK script (e.g. http://localhost:3000/dist/index.js)
const BROWSERS      = parseInt(args['browsers'] || '3', 10)
const SESSION_SECS  = parseInt(args['duration'] || '15', 10)
const HEADLESS      = args['headed'] !== 'true'
const PAGE_URL      = args['page-url'] || ''        // Optional: load an external page instead of test-page.html

if (!APP_KEY) {
  console.error(
    'Usage: npx tsx main.ts --app-key KEY [--sdk-url URL] [--browsers N] [--duration SECS] [--headed] [--page-url URL]'
  )
  console.error('')
  console.error('  --app-key      Required. Your UXCam app key.')
  console.error('  --sdk-url      URL to the built SDK script (e.g. http://localhost:3000/dist/index.js).')
  console.error('                 If omitted, loads from https://websdk-recording.uxcam.com/index.js')
  console.error('  --browsers     Number of concurrent browser instances (default: 3)')
  console.error('  --duration     How long each session runs in seconds (default: 15)')
  console.error('  --headed       Show browser windows (default: headless)')
  console.error('  --page-url     Load an external page instead of the built-in test page')
  process.exit(1)
}

const sdkSrc = SDK_URL || 'https://websdk-recording.uxcam.com/index.js'

// ── Local HTTP server ─────────────────────────────────────
// Serves the test page over http://localhost so sessionStorage works.
let testPageServer: http.Server | null = null
let testPagePort = 0

function startTestPageServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const htmlPath = path.join(__dirname, 'test-page.html')
    let html = fs.readFileSync(htmlPath, 'utf-8')

    html = html.replace(
      '<script id="uxcam-init"></script>',
      `<script type="text/javascript">${buildSDKSnippet(APP_KEY, sdkSrc)}</script>`
    )

    testPageServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(html)
    })

    testPageServer.listen(0, '127.0.0.1', () => {
      const addr = testPageServer!.address()
      if (typeof addr === 'object' && addr) {
        testPagePort = addr.port
        resolve(addr.port)
      } else {
        reject(new Error('Failed to start test page server'))
      }
    })
  })
}

// ── Metrics ───────────────────────────────────────────────
interface SessionResult {
  browserId: number
  sessionId: string | null
  connected: boolean
  initSent: boolean
  dataBatches: number
  errors: string[]
  durationMs: number
}

const results: SessionResult[] = []

// ── Bot-detection bypass ──────────────────────────────────
// The SDK checks navigator.webdriver and UA patterns.
// We override these before any page script runs.
async function bypassBotDetection(page: Page) {
  await page.evaluateOnNewDocument(() => {
    // Hide webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => false })

    // Set realistic languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })

    // Add chrome object
    const win = window as Record<string, unknown>
    if (!win.chrome) {
      win.chrome = { runtime: {} }
    }
  })
}

// ── SDK injection snippet ─────────────────────────────────
function buildSDKSnippet(appKey: string, sdkSource: string): string {
  return `
    (function(appKey, opts) {
      window.uxc = {
        __t: [],
        __ak: appKey,
        __o: opts,
        event: function(n, p) { this.__t.push(['event', n, p]) },
        setUserIdentity: function(i) { this.__t.push(['setUserIdentity', i]) },
        setUserProperty: function(k, v) { this.__t.push(['setUserProperty', k, v]) },
        setUserProperties: function(p) { this.__t.push(['setUserProperties', p]) },
        abort: function() { this.__t.push(['abort']) }
      };
      var script = document.createElement('script');
      script.src = '${sdkSource}';
      script.async = true;
      script.defer = true;
      script.id = 'uxcam-web-sdk';
      script.crossOrigin = 'anonymous';
      document.head.appendChild(script);
    })('${appKey}', { appVersion: 'load-test-1.0' });
  `
}

// ── User interaction simulation ───────────────────────────
async function simulateUserActivity(page: Page, durationSecs: number) {
  const endTime = Date.now() + durationSecs * 1000

  while (Date.now() < endTime) {
    try {
      // Random mouse movement
      const x = 100 + Math.random() * 600
      const y = 100 + Math.random() * 400
      await page.mouse.move(x, y)

      // Click a random button
      const buttons = await page.$$('button')
      if (buttons.length > 0) {
        const btn = buttons[Math.floor(Math.random() * buttons.length)]
        await btn.click().catch(() => {})
      }

      // Type in an input
      const inputs = await page.$$('input')
      if (inputs.length > 0) {
        const input = inputs[Math.floor(Math.random() * inputs.length)]
        await input.click().catch(() => {})
        await page.keyboard.type('test', { delay: 50 })
      }

      // Scroll
      await page.evaluate(() => {
        window.scrollBy(0, Math.random() * 200 - 100)
      })

      // Wait between actions
      await sleep(500 + Math.random() * 1000)
    } catch {
      // Page might have navigated or closed
      break
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Single browser session ────────────────────────────────
async function runBrowserSession(browserId: number): Promise<SessionResult> {
  const result: SessionResult = {
    browserId,
    sessionId: null,
    connected: false,
    initSent: false,
    dataBatches: 0,
    errors: [],
    durationMs: 0,
  }

  const startTime = Date.now()
  let browser: Browser | null = null

  try {
    browser = await puppeteer.launch({
      headless: HEADLESS,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    })

    const page = await browser.newPage()

    // Set a realistic user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    )

    await bypassBotDetection(page)

    // Monitor console for SDK debug logs
    page.on('console', msg => {
      const text = msg.text()
      if (text.includes('[UXCam]')) {
        const tag = `[B${browserId}]`

        if (text.includes('Bot/crawler detected')) {
          result.errors.push('Bot detection triggered')
          console.log(`  ${tag} ⚠ Bot detection triggered`)
        }
        if (text.includes('WebSocket connected successfully')) {
          result.connected = true
          console.log(`  ${tag} ✓ WebSocket connected`)
        }
        if (text.includes('Initializing WebSocket connection')) {
          console.log(`  ${tag} … WebSocket connecting`)
        }
        if (text.includes('Connection error')) {
          result.errors.push('WebSocket connection error')
          console.log(`  ${tag} ✗ Connection error`)
        }
        if (text.includes('Session saved to storage')) {
          console.log(`  ${tag} ✓ Session saved`)
        }
      }
    })

    // Intercept WebSocket frames to detect session_init
    const cdp = await page.createCDPSession()
    await cdp.send('Network.enable')

    cdp.on('Network.webSocketFrameSent', (params) => {
      const payload = params.response?.payloadData || ''
      if (payload.includes('session_init')) {
        result.initSent = true
        console.log(`  [B${browserId}] ✓ session_init sent`)
      }
      if (payload.includes('session_data')) {
        result.dataBatches++
      }
    })

    cdp.on('Network.webSocketCreated', () => {
      console.log(`  [B${browserId}] … WebSocket created`)
    })

    // Load the page over HTTP (sessionStorage requires a real origin)
    if (PAGE_URL) {
      await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
    } else {
      await page.goto(`http://127.0.0.1:${testPagePort}/`, { waitUntil: 'domcontentloaded' })
    }

    // Wait for SDK to initialize
    await sleep(3000)

    // Try to get session ID from storage
    const sessionId = await page.evaluate(() => {
      return sessionStorage.getItem('uxcam:0.1:session:key')
    })
    result.sessionId = sessionId

    if (sessionId) {
      console.log(`  [B${browserId}] ✓ Session ID: ${sessionId}`)
    } else {
      console.log(`  [B${browserId}] ✗ No session ID in storage`)
    }

    // Simulate user activity to generate DOM changes
    console.log(`  [B${browserId}] … Simulating user activity for ${SESSION_SECS}s`)
    await simulateUserActivity(page, SESSION_SECS)

    // Wait a bit for final data flush
    await sleep(2000)

    // Final data batch count
    result.dataBatches = await page.evaluate(() => {
      // Check if session_data was sent by looking at sequence counter
      const seq = sessionStorage.getItem('uxcam:0.1:session:seq')
      return seq ? parseInt(seq, 10) : 0
    }).catch(() => result.dataBatches)

  } catch (err) {
    result.errors.push(String(err))
    console.error(`  [B${browserId}] Error: ${err}`)
  } finally {
    result.durationMs = Date.now() - startTime
    if (browser) {
      await browser.close()
    }
  }

  return result
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  console.log(`\n  Puppeteer SDK Load Test`)
  console.log(`  ─────────────────────────────────────────`)
  console.log(`  App Key:    ${APP_KEY}`)
  console.log(`  SDK URL:    ${sdkSrc}`)
  console.log(`  Browsers:   ${BROWSERS}`)
  console.log(`  Duration:   ${SESSION_SECS}s per session`)
  console.log(`  Mode:       ${HEADLESS ? 'headless' : 'headed'}`)
  console.log(`  ─────────────────────────────────────────\n`)

  // Start local HTTP server for the test page
  if (!PAGE_URL) {
    const port = await startTestPageServer()
    console.log(`  Test page:  http://127.0.0.1:${port}/\n`)
  }

  const startTime = Date.now()

  // Launch all browser sessions in parallel
  const promises = Array.from({ length: BROWSERS }, (_, i) => runBrowserSession(i))
  const sessionResults = await Promise.allSettled(promises)

  for (const r of sessionResults) {
    if (r.status === 'fulfilled') {
      results.push(r.value)
    }
  }

  // ── Summary ───────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  const totalSessions = results.length
  const sessionsWithId = results.filter(r => r.sessionId).length
  const sessionsConnected = results.filter(r => r.connected).length
  const sessionsInitSent = results.filter(r => r.initSent).length
  const sessionsWithData = results.filter(r => r.dataBatches > 0).length
  const sessionsWithErrors = results.filter(r => r.errors.length > 0).length
  const totalDataBatches = results.reduce((sum, r) => sum + r.dataBatches, 0)

  console.log(`\n  ── Results (${elapsed}s) ──────────────────────────`)
  console.log(`  Browsers launched:  ${totalSessions}`)
  console.log(`  Session ID created: ${sessionsWithId}/${totalSessions}`)
  console.log(`  WebSocket connected:${sessionsConnected}/${totalSessions}`)
  console.log(`  session_init sent:  ${sessionsInitSent}/${totalSessions}`)
  console.log(`  Sessions with data: ${sessionsWithData}/${totalSessions}`)
  console.log(`  Total data batches: ${totalDataBatches}`)
  console.log(`  Errors:             ${sessionsWithErrors}/${totalSessions}`)

  if (sessionsWithErrors > 0) {
    console.log(`\n  Errors:`)
    for (const r of results) {
      if (r.errors.length > 0) {
        console.log(`    [B${r.browserId}] ${r.errors.join(', ')}`)
      }
    }
  }

  // Per-session detail table
  console.log(`\n  ── Per-Session Detail ──────────────────────`)
  console.log(`  ${'ID'.padEnd(4)} ${'Session'.padEnd(38)} ${'WS'.padEnd(5)} ${'Init'.padEnd(5)} ${'Data'.padEnd(6)} ${'Time'.padEnd(8)} Status`)
  console.log(`  ${'─'.repeat(4)} ${'─'.repeat(38)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(10)}`)

  for (const r of results) {
    const sid = r.sessionId ? r.sessionId.substring(0, 36) : '(none)'.padEnd(36)
    const ws = r.connected ? 'yes' : 'no'
    const init = r.initSent ? 'yes' : 'no'
    const data = String(r.dataBatches)
    const time = `${(r.durationMs / 1000).toFixed(1)}s`
    const status = r.errors.length > 0 ? 'ERROR' : r.initSent ? 'OK' : 'WARN'

    console.log(`  B${String(r.browserId).padEnd(3)} ${sid} ${ws.padEnd(5)} ${init.padEnd(5)} ${data.padEnd(6)} ${time.padEnd(8)} ${status}`)
  }

  // Verdict
  console.log('')
  if (sessionsInitSent === totalSessions) {
    console.log(`  ✓ ALL sessions sent session_init successfully`)
  } else if (sessionsInitSent > 0) {
    console.log(`  ~ ${sessionsInitSent}/${totalSessions} sessions sent session_init`)
  } else {
    console.log(`  ✗ NO sessions sent session_init — check bot detection or SDK URL`)
  }
  console.log('')

  // Shutdown local server
  if (testPageServer) {
    testPageServer.close()
  }

  process.exit(sessionsWithErrors > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
