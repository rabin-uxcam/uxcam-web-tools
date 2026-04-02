import { v4 as uuidv4 } from 'uuid'
import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// --- Load test.json and split into page-load + subsequent changes ---

const rawChanges: Record<string, unknown>[] = JSON.parse(
  readFileSync(path.join(__dirname, 'test.json'), 'utf-8')
)

// Find PAGE_LOAD entry (ct=13) — this must be sent first
const pageLoadIndex = rawChanges.findIndex((e) => e.ct === '13')
// Everything up to and including PAGE_LOAD goes in the initial batch
const initialChanges = rawChanges.slice(0, pageLoadIndex + 1)
// Everything after PAGE_LOAD is subsequent data
const subsequentChanges = rawChanges.slice(pageLoadIndex + 1)

// --- Device data pools ---

const OS_TYPES = ['Windows', 'Mac OS', 'Linux', 'iOS', 'Android']
const OS_VERSIONS = ['10.0', '14.5', '13.0', '17.2', '15.0', '11.0', '22.04']
const DEVICE_TYPES = ['Desktop', 'Mobile', 'Tablet']
const BROWSERS = ['Chrome', 'Firefox', 'Safari', 'Edge']
const BROWSER_VERSIONS = ['120.0.0', '121.0.0', '17.2', '119.0.0', '122.0.0']
const LANGUAGES = ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP', 'es-ES']
const NETWORK_TYPES = ['4g', 'wifi', 'ethernet', '3g']
const RESOLUTIONS = [
  [1920, 1080], [1366, 768], [1440, 900], [2560, 1440],
  [375, 812], [414, 896], [390, 844], [768, 1024],
]
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

// --- session_init payload ---

export function makeSessionInitPayload(sessionId: string, deviceId: string, appKey: string) {
  const [w, h] = pick(RESOLUTIONS)
  return {
    sessionId,
    deviceId,
    appKey,
    deviceTime: new Date().toISOString(),
    deviceData: {
      osType: pick(OS_TYPES),
      osVersion: pick(OS_VERSIONS),
      deviceType: pick(DEVICE_TYPES),
      deviceManufacturer: 'unknown',
      deviceClass: 'unknown',
      deviceModel: 'unknown',
      deviceLanguage: pick(LANGUAGES),
      browser: pick(BROWSERS),
      browserVersion: pick(BROWSER_VERSIONS),
      displayWidth: w,
      displayHeight: h,
      displayDpi: pick([1, 1.5, 2, 3]),
      networkType: pick(NETWORK_TYPES),
      sdkVersion: '0.1.0-loadtest',
      sdkVersionNumber: 100,
      appVersion: '1.0.0',
      utm: { source: null, medium: null, campaign: null, term: null, content: null },
      referer: null,
      userAgent: pick(USER_AGENTS),
    },
  }
}

// --- session_data payloads from test.json ---

function gzipChanges(changes: Record<string, unknown>[]): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(changes)))
}

/**
 * Returns the ordered list of gzipped batches to send for one session.
 * Batch 0: initial changes (WINDOW_RESIZE + PAGE_LOAD with full DOM snapshot)
 * Batch 1..N: subsequent changes split into chunks of `batchSize`
 */
export function buildSessionBatches(sessionId: string, batchSize: number): { sid: string; data: Buffer; vi: boolean }[] {
  const batches: { sid: string; data: Buffer; vi: boolean }[] = []

  // Batch 0: page load (always first)
  batches.push({
    sid: sessionId,
    data: gzipChanges(initialChanges),
    vi: true,
  })

  // Subsequent batches
  for (let i = 0; i < subsequentChanges.length; i += batchSize) {
    const chunk = subsequentChanges.slice(i, i + batchSize)
    batches.push({
      sid: sessionId,
      data: gzipChanges(chunk),
      vi: true,
    })
  }

  return batches
}

// --- Identity generators ---

export function makeSessionId(): string {
  return uuidv4()
}

export function makeDeviceId(): string {
  return uuidv4().replace(/-/g, '').slice(0, 16)
}
