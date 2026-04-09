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
const APP_KEY = args['app-key']
const SDK_URL = args['sdk-url'] || ''

if (!APP_KEY) {
  console.error('Usage: npx tsx bot-detection.ts --app-key KEY [--sdk-url URL]')
  process.exit(1)
}

const sdkSrc = SDK_URL || 'https://websdk-recording.uxcam.com/index.js'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

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
    })('${appKey}', { appVersion: 'bot-detection-test' });
  `
}

// ── Local HTTP server ─────────────────────────────────────
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

// ── Test case definition ──────────────────────────────────

interface TestCase {
  name: string
  description: string
  // What isBot() check this targets
  check: string
  // Whether the SDK should be BLOCKED (true) or ALLOWED (false)
  expectBlocked: boolean
  // Configure the browser/page to trigger or not trigger bot detection
  setup: (page: Page) => Promise<void>
  // Extra browser launch args
  launchArgs?: string[]
  // Custom user agent (undefined = use Puppeteer default)
  userAgent?: string
}

const TEST_CASES: TestCase[] = [
  // ─── Check 1: navigator.webdriver ───────────────────────
  {
    name: 'webdriver-default',
    description: 'Default Puppeteer (navigator.webdriver = true)',
    check: 'navigator.webdriver',
    expectBlocked: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    setup: async (page) => {
      // Only set languages + chrome to isolate the webdriver check.
      // Do NOT override webdriver — leave it as true.
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
        const win = window as Record<string, unknown>
        if (!win.chrome) win.chrome = { runtime: {} }
      })
    },
  },
  {
    name: 'webdriver-bypassed',
    description: 'navigator.webdriver overridden to false',
    check: 'navigator.webdriver',
    expectBlocked: false,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    launchArgs: ['--disable-blink-features=AutomationControlled'],
    setup: async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
        const win = window as Record<string, unknown>
        if (!win.chrome) win.chrome = { runtime: {} }
      })
    },
  },

  // ─── Check 2: User-Agent bot patterns ───────────────────
  {
    name: 'ua-headless',
    description: 'UA contains "HeadlessChrome" (default Puppeteer UA)',
    check: 'UA pattern: headless',
    expectBlocked: true,
    // Don't set a custom UA — Puppeteer default contains "HeadlessChrome"
    setup: async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
        const win = window as Record<string, unknown>
        if (!win.chrome) win.chrome = { runtime: {} }
      })
    },
  },
  {
    name: 'ua-googlebot',
    description: 'UA contains "googlebot"',
    check: 'UA pattern: googlebot',
    expectBlocked: true,
    userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    setup: async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
        const win = window as Record<string, unknown>
        if (!win.chrome) win.chrome = { runtime: {} }
      })
    },
  },
  {
    name: 'ua-puppeteer',
    description: 'UA explicitly contains "puppeteer"',
    check: 'UA pattern: puppeteer',
    expectBlocked: true,
    userAgent: 'Mozilla/5.0 puppeteer-test-agent',
    setup: async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
        const win = window as Record<string, unknown>
        if (!win.chrome) win.chrome = { runtime: {} }
      })
    },
  },
  {
    name: 'ua-selenium',
    description: 'UA contains "selenium"',
    check: 'UA pattern: selenium',
    expectBlocked: true,
    userAgent: 'Mozilla/5.0 selenium-webdriver/4.0',
    setup: async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
        const win = window as Record<string, unknown>
        if (!win.chrome) win.chrome = { runtime: {} }
      })
    },
  },
  {
    name: 'ua-playwright',
    description: 'UA contains "playwright"',
    check: 'UA pattern: playwright',
    expectBlocked: true,
    userAgent: 'Mozilla/5.0 playwright/1.40',
    setup: async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
        const win = window as Record<string, unknown>
        if (!win.chrome) win.chrome = { runtime: {} }
      })
    },
  },
  {
    name: 'ua-lighthouse',
    description: 'UA contains "lighthouse"',
    check: 'UA pattern: lighthouse',
    expectBlocked: true,
    userAgent: 'Mozilla/5.0 Chrome/120.0 Lighthouse',
    setup: async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
        const win = window as Record<string, unknown>
        if (!win.chrome) win.chrome = { runtime: {} }
      })
    },
  },
  {
    name: 'ua-slack-preview',
    description: 'UA contains "slack" (link preview bot)',
    check: 'UA pattern: slack',
    expectBlocked: true,
    userAgent: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    setup: async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
        const win = window as Record<string, unknown>
        if (!win.chrome) win.chrome = { runtime: {} }
      })
    },
  },
  {
    name: 'ua-clean',
    description: 'Clean Chrome UA (no bot patterns)',
    check: 'UA pattern: none',
    expectBlocked: false,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    launchArgs: ['--disable-blink-features=AutomationControlled'],
    setup: async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
        const win = window as Record<string, unknown>
        if (!win.chrome) win.chrome = { runtime: {} }
      })
    },
  },

  // ─── Check 3: Missing browser fingerprint ───────────────
  {
    name: 'no-chrome-no-languages',
    description: 'No window.chrome + empty navigator.languages',
    check: 'Missing fingerprint (no chrome, no languages)',
    expectBlocked: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    launchArgs: ['--disable-blink-features=AutomationControlled'],
    setup: async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        // Deliberately set empty languages and remove chrome
        Object.defineProperty(navigator, 'languages', { get: () => [] })
        const win = window as Record<string, unknown>
        delete win.chrome
      })
    },
  },
  {
    name: 'no-chrome-has-languages',
    description: 'No window.chrome but has navigator.languages',
    check: 'Missing fingerprint (no chrome, has languages)',
    expectBlocked: false,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    launchArgs: ['--disable-blink-features=AutomationControlled'],
    setup: async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
        // No chrome object — but languages present, so should pass
      })
    },
  },
  {
    name: 'has-chrome-no-languages',
    description: 'Has window.chrome but empty navigator.languages',
    check: 'Missing fingerprint (has chrome, no languages)',
    expectBlocked: false,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    launchArgs: ['--disable-blink-features=AutomationControlled'],
    setup: async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'languages', { get: () => [] })
        const win = window as Record<string, unknown>
        if (!win.chrome) win.chrome = { runtime: {} }
      })
    },
  },
  {
    name: 'safari-no-chrome',
    description: 'Safari vendor (Apple) — no window.chrome needed',
    check: 'Missing fingerprint (Apple vendor bypass)',
    expectBlocked: false,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
    launchArgs: ['--disable-blink-features=AutomationControlled'],
    setup: async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'vendor', { get: () => 'Apple Computer, Inc.' })
        Object.defineProperty(navigator, 'languages', { get: () => [] })
        // No chrome, no languages — but Apple vendor should bypass
      })
    },
  },
  {
    name: 'firefox-no-chrome',
    description: 'Firefox UA — no window.chrome needed',
    check: 'Missing fingerprint (Firefox UA bypass)',
    expectBlocked: false,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
    launchArgs: ['--disable-blink-features=AutomationControlled'],
    setup: async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'languages', { get: () => [] })
        // No chrome, no languages — but "firefox" in UA should bypass
      })
    },
  },

  // ─── Check 4: Automation tool globals ───────────────────
  {
    name: 'phantom-global',
    description: 'window._phantom is set',
    check: 'Global: window._phantom',
    expectBlocked: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    launchArgs: ['--disable-blink-features=AutomationControlled'],
    setup: async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
        const win = window as Record<string, unknown>
        if (!win.chrome) win.chrome = { runtime: {} }
        win._phantom = true
      })
    },
  },
  {
    name: 'nightmare-global',
    description: 'window.__nightmare is set',
    check: 'Global: window.__nightmare',
    expectBlocked: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    launchArgs: ['--disable-blink-features=AutomationControlled'],
    setup: async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
        const win = window as Record<string, unknown>
        if (!win.chrome) win.chrome = { runtime: {} }
        win.__nightmare = { version: '3.0' }
      })
    },
  },
  {
    name: 'callphantom-global',
    description: 'window.callPhantom is set',
    check: 'Global: window.callPhantom',
    expectBlocked: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    launchArgs: ['--disable-blink-features=AutomationControlled'],
    setup: async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
        const win = window as Record<string, unknown>
        if (!win.chrome) win.chrome = { runtime: {} }
        win.callPhantom = () => {}
      })
    },
  },
  {
    name: 'no-globals',
    description: 'No automation globals set',
    check: 'Global: none',
    expectBlocked: false,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    launchArgs: ['--disable-blink-features=AutomationControlled'],
    setup: async (page) => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
        const win = window as Record<string, unknown>
        if (!win.chrome) win.chrome = { runtime: {} }
      })
    },
  },
]

// ── Run a single test case ────────────────────────────────
interface TestResult {
  name: string
  description: string
  check: string
  expectBlocked: boolean
  actualBlocked: boolean
  passed: boolean
  reason: string
}

async function runTestCase(tc: TestCase): Promise<TestResult> {
  let browser: Browser | null = null

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        ...(tc.launchArgs || []),
      ],
    })

    const page = await browser.newPage()

    if (tc.userAgent) {
      await page.setUserAgent(tc.userAgent)
    }

    await tc.setup(page)

    // Track SDK behavior
    let botDetected = false
    let wsConnected = false
    let sessionInitSent = false

    page.on('console', msg => {
      const text = msg.text()
      if (text.includes('Bot/crawler detected')) botDetected = true
      if (text.includes('WebSocket connected successfully')) wsConnected = true
    })

    const cdp = await page.createCDPSession()
    await cdp.send('Network.enable')
    cdp.on('Network.webSocketFrameSent', (params) => {
      const payload = params.response?.payloadData || ''
      if (payload.includes('session_init')) sessionInitSent = true
    })

    // Load page
    await page.goto(`http://127.0.0.1:${testPagePort}/`, { waitUntil: 'domcontentloaded' })
    await sleep(5000)

    // Check session storage
    const sessionId = await page.evaluate(() => {
      try {
        return sessionStorage.getItem('uxcam:0.1:session:key')
      } catch { return null }
    })

    const actualBlocked = botDetected || (!wsConnected && !sessionId && !sessionInitSent)

    let reason: string
    if (botDetected) {
      reason = 'Bot/crawler log detected'
    } else if (sessionInitSent) {
      reason = 'session_init sent'
    } else if (wsConnected) {
      reason = 'WebSocket connected'
    } else if (sessionId) {
      reason = 'Session ID in storage'
    } else {
      reason = 'No SDK activity (no WS, no session, no init)'
    }

    return {
      name: tc.name,
      description: tc.description,
      check: tc.check,
      expectBlocked: tc.expectBlocked,
      actualBlocked,
      passed: tc.expectBlocked === actualBlocked,
      reason,
    }
  } catch (err) {
    return {
      name: tc.name,
      description: tc.description,
      check: tc.check,
      expectBlocked: tc.expectBlocked,
      actualBlocked: false,
      passed: false,
      reason: `Error: ${err}`,
    }
  } finally {
    if (browser) await browser.close()
  }
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  console.log(`\n  SDK Bot Detection Test`)
  console.log(`  ─────────────────────────────────────────`)
  console.log(`  App Key:     ${APP_KEY}`)
  console.log(`  SDK URL:     ${sdkSrc}`)
  console.log(`  Test cases:  ${TEST_CASES.length}`)
  console.log(`  ─────────────────────────────────────────\n`)

  const port = await startTestPageServer()
  console.log(`  Test page:   http://127.0.0.1:${port}/\n`)

  const results: TestResult[] = []

  // Run tests sequentially to keep output readable
  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i]
    process.stdout.write(`  [${i + 1}/${TEST_CASES.length}] ${tc.name} … `)
    const result = await runTestCase(tc)
    results.push(result)

    const icon = result.passed ? '✓' : '✗'
    const status = result.passed ? 'PASS' : 'FAIL'
    console.log(`${icon} ${status}  (${result.reason})`)
  }

  // ── Summary by check category ────────────────────────────
  console.log(`\n  ── Results ──────────────────────────────────────────────────────────────────────`)
  console.log(`  ${'Test'.padEnd(28)} ${'Check'.padEnd(42)} ${'Expect'.padEnd(9)} ${'Actual'.padEnd(9)} Result`)
  console.log(`  ${'─'.repeat(28)} ${'─'.repeat(42)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(6)}`)

  for (const r of results) {
    const expect = r.expectBlocked ? 'BLOCKED' : 'ALLOWED'
    const actual = r.actualBlocked ? 'BLOCKED' : 'ALLOWED'
    const status = r.passed ? 'PASS' : 'FAIL'
    const icon = r.passed ? '✓' : '✗'
    console.log(`  ${r.name.padEnd(28)} ${r.check.padEnd(42)} ${expect.padEnd(9)} ${actual.padEnd(9)} ${icon} ${status}`)
  }

  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length

  console.log(`\n  ── Verdict ──────────────────────────────────`)
  console.log(`  Total:  ${results.length}`)
  console.log(`  Passed: ${passed}`)
  console.log(`  Failed: ${failed}`)

  if (failed === 0) {
    console.log(`\n  ✓ All bot detection checks working correctly`)
  } else {
    console.log(`\n  ✗ ${failed} check(s) failed — bot detection has gaps`)
    console.log(`\n  Failed cases:`)
    for (const r of results.filter(r => !r.passed)) {
      const expected = r.expectBlocked ? 'BLOCKED' : 'ALLOWED'
      const got = r.actualBlocked ? 'BLOCKED' : 'ALLOWED'
      console.log(`    ${r.name}: expected ${expected}, got ${got} — ${r.reason}`)
    }
  }
  console.log('')

  if (testPageServer) testPageServer.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
