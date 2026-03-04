#!/usr/bin/env node

/**
 * Canvas-Video ↔ data.json Sync Validator
 *
 * Maps every data.json timestamp (screen transitions, events, clicks)
 * to a video frame number, so you can visually verify sync.
 *
 * Usage:
 *   node validate-sync.mjs --data ./data.json --dir ./local-batches
 *   node validate-sync.mjs --data ./data.json --dir ./local-batches --fps 30
 *   node validate-sync.mjs --data ./data.json --dir ./local-batches --tolerance 0.1
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { parseBatch } from './parse-batch.mjs'

// ─── CLI Args ────────────────────────────────────────────────────────────────

function getArg(flag) {
	const idx = process.argv.indexOf(flag)
	return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null
}

const DATA_JSON_PATH = getArg('--data')
const LOCAL_DIR = getArg('--dir')
const FPS = getArg('--fps') ? parseInt(getArg('--fps'), 10) : 60
const TOLERANCE_SEC = getArg('--tolerance') ? parseFloat(getArg('--tolerance')) : 0.05 // 50ms

if (!DATA_JSON_PATH || !LOCAL_DIR) {
	console.error('Usage: node validate-sync.mjs --data <path/to/data.json> --dir <path/to/batch-bins>')
	process.exit(1)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(sec) {
	const m = Math.floor(sec / 60)
	const s = (sec % 60).toFixed(1)
	return `${m}:${s.padStart(4, '0')}`
}

function findNearestFrame(frames, targetMs) {
	let lo = 0, hi = frames.length - 1
	while (lo < hi) {
		const mid = (lo + hi) >> 1
		if (frames[mid].time < targetMs) lo = mid + 1
		else hi = mid
	}
	if (lo > 0 && Math.abs(frames[lo - 1].time - targetMs) < Math.abs(frames[lo].time - targetMs)) {
		return { frame: frames[lo - 1], index: lo - 1 }
	}
	return { frame: frames[lo], index: lo }
}

function msToVideoFrame(timeMs, firstFrameMs) {
	const idx = Math.floor((timeMs - firstFrameMs) / (1000 / FPS))
	return Math.max(0, idx)
}

function severity(driftSec) {
	if (driftSec <= TOLERANCE_SEC) return 'OK'
	if (driftSec <= TOLERANCE_SEC * 3) return 'WARN'
	return 'ERROR'
}

// ─── Load data.json ──────────────────────────────────────────────────────────

const dataJson = JSON.parse(readFileSync(DATA_JSON_PATH, 'utf8'))
const screenTimeline = dataJson.st || []
const events = dataJson.evt || []
const totalTimeSec = dataJson.session?.tt ?? 0
const sessionId = dataJson.session?.id ?? 'unknown'

// ─── Load canvas batches ─────────────────────────────────────────────────────

const batchFiles = readdirSync(LOCAL_DIR)
	.filter((f) => f.endsWith('.bin'))
	.sort()
	.map((f) => join(LOCAL_DIR, f))

if (batchFiles.length === 0) {
	console.error(`No .bin files found in ${LOCAL_DIR}`)
	process.exit(1)
}

const allFrames = []
const batchErrors = []
let prevBatchIndex = -1

for (const filePath of batchFiles) {
	const raw = readFileSync(filePath)
	let decompressed
	try {
		decompressed = gunzipSync(raw)
	} catch {
		decompressed = raw
	}

	const batch = parseBatch(decompressed)

	// Batch integrity check
	if (batch.batchIndex <= prevBatchIndex) {
		batchErrors.push(`Batch ${batch.batchIndex} in ${basename(filePath)} is out of order (prev: ${prevBatchIndex})`)
	}
	prevBatchIndex = batch.batchIndex

	let prevTime = -1
	for (let i = 0; i < batch.frames.length; i++) {
		const f = batch.frames[i]
		if (f.time < prevTime) {
			batchErrors.push(`Non-monotonic time in batch ${batch.batchIndex}, frame ${i}: ${f.time} < ${prevTime}`)
		}
		prevTime = f.time
		allFrames.push({
			time: f.time,
			width: f.width,
			height: f.height,
			batchIndex: batch.batchIndex,
			frameIndexInBatch: i,
		})
	}
}

allFrames.sort((a, b) => a.time - b.time)

if (allFrames.length === 0) {
	console.error('No frames found in batch files')
	process.exit(1)
}

const firstFrameMs = allFrames[0].time
const lastFrameMs = allFrames[allFrames.length - 1].time
const videoSpanMs = lastFrameMs - firstFrameMs
const totalVideoFrames = Math.ceil(videoSpanMs / (1000 / FPS)) + 1

// ─── Report ──────────────────────────────────────────────────────────────────

console.log('=== Canvas-Video ↔ data.json Sync Report ===\n')
console.log(`Session:            ${sessionId}`)
console.log(`data.json duration: ${totalTimeSec.toFixed(3)}s`)
console.log(`Canvas time span:   ${(videoSpanMs / 1000).toFixed(3)}s (first frame at ${(firstFrameMs / 1000).toFixed(3)}s, last at ${(lastFrameMs / 1000).toFixed(3)}s)`)
console.log(`Video:              ${totalVideoFrames} frames at ${FPS}fps`)
console.log(`Source frames:      ${allFrames.length} from ${batchFiles.length} batch files`)
console.log(`Tolerance:          ${(TOLERANCE_SEC * 1000).toFixed(0)}ms`)
console.log()

// ─── Check 1: Duration ──────────────────────────────────────────────────────

console.log('--- Duration ---')
const canvasDurationSec = videoSpanMs / 1000
const durationDiff = Math.abs(totalTimeSec - canvasDurationSec)
console.log(`  data.json tt:     ${totalTimeSec.toFixed(3)}s`)
console.log(`  Canvas span:      ${canvasDurationSec.toFixed(3)}s`)
console.log(`  Difference:       ${durationDiff.toFixed(3)}s`)

if (firstFrameMs > 0) {
	console.log(`  [NOTE] Canvas starts ${(firstFrameMs / 1000).toFixed(3)}s after session start`)
}

const lastDataTimeSec = screenTimeline.length > 0
	? screenTimeline[screenTimeline.length - 1].at + screenTimeline[screenTimeline.length - 1].vt
	: 0
const canvasEndSec = lastFrameMs / 1000
if (canvasEndSec < lastDataTimeSec) {
	console.log(`  [WARN] Canvas ends at ${canvasEndSec.toFixed(3)}s but session runs until ${lastDataTimeSec.toFixed(3)}s`)
}
console.log()

// ─── Check 2: Screen Transitions → Video Frames ────────────────────────────

console.log('--- Screen Timeline → Video Frames ---')
console.log(`  ${'Screen'.padEnd(30)} ${'Time Range'.padEnd(22)} ${'Video Frames'.padEnd(20)} ${'Canvas Frames'}`)
console.log(`  ${'─'.repeat(30)} ${'─'.repeat(22)} ${'─'.repeat(20)} ${'─'.repeat(15)}`)

for (const screen of screenTimeline) {
	const startMs = screen.at * 1000
	const endMs = (screen.at + screen.vt) * 1000
	const startFrame = msToVideoFrame(startMs, firstFrameMs)
	const endFrame = msToVideoFrame(endMs, firstFrameMs)
	const framesInRange = allFrames.filter((f) => f.time >= startMs && f.time <= endMs).length

	const name = (screen.an || 'unknown').slice(0, 28).padEnd(30)
	const timeRange = `${formatTime(screen.at)} - ${formatTime(screen.at + screen.vt)}`.padEnd(22)
	const videoRange = `#${startFrame} - #${endFrame}`.padEnd(20)

	let status = ''
	if (framesInRange === 0) status = ' [WARN: no canvas frames]'
	else if (framesInRange < 3) status = ` [NOTE: only ${framesInRange}]`

	console.log(`  ${name} ${timeRange} ${videoRange} ${framesInRange}${status}`)
}
console.log()

// ─── Check 3: Events → Video Frames ────────────────────────────────────────

console.log('--- Events → Video Frames ---')
console.log(`  ${'Event'.padEnd(25)} ${'Time'.padEnd(10)} ${'Video Frame'.padEnd(14)} ${'Nearest Canvas'.padEnd(16)} ${'Drift'.padEnd(10)} ${'Status'}`)
console.log(`  ${'─'.repeat(25)} ${'─'.repeat(10)} ${'─'.repeat(14)} ${'─'.repeat(16)} ${'─'.repeat(10)} ${'─'.repeat(6)}`)

let maxDrift = 0
const drifts = []

for (const evt of events) {
	const eventMs = evt.time * 1000
	const videoFrame = msToVideoFrame(eventMs, firstFrameMs)
	const nearest = findNearestFrame(allFrames, eventMs)
	const driftMs = Math.abs(nearest.frame.time - eventMs)
	const driftSec = driftMs / 1000
	const sev = eventMs < firstFrameMs ? 'ERROR' : severity(driftSec)

	if (driftMs > maxDrift) maxDrift = driftMs
	drifts.push(driftMs)

	const name = (evt.name || '?').slice(0, 23).padEnd(25)
	const time = `${evt.time.toFixed(3)}s`.padEnd(10)
	const frame = `#${videoFrame}`.padEnd(14)
	const nearestStr = `${(nearest.frame.time / 1000).toFixed(3)}s`.padEnd(16)
	const driftStr = `${driftMs.toFixed(0)}ms`.padEnd(10)

	console.log(`  ${name} ${time} ${frame} ${nearestStr} ${driftStr} [${sev}]`)
}
console.log()

// ─── Check 4: Clicks/Gestures → Video Frames ───────────────────────────────

let totalClicks = 0
let clickIssues = 0

console.log('--- Clicks/Gestures → Video Frames ---')

for (const screen of screenTimeline) {
	if (!screen.cor || screen.cor.length === 0) continue

	for (const click of screen.cor) {
		totalClicks++
		const clickTimeSec = click[5] // index 5 is time in seconds
		const clickMs = clickTimeSec * 1000
		const videoFrame = msToVideoFrame(clickMs, firstFrameMs)
		const nearest = findNearestFrame(allFrames, clickMs)
		const driftMs = Math.abs(nearest.frame.time - clickMs)
		const driftSec = driftMs / 1000

		if (driftMs > maxDrift) maxDrift = driftMs
		drifts.push(driftMs)

		const inRange = clickMs >= screen.at * 1000 && clickMs <= (screen.at + screen.vt) * 1000
		if (!inRange) clickIssues++

		const sev = !inRange ? 'ERROR' : severity(driftSec)
		const gestureTypes = ['click', 'dblclick', 'swipe-up', 'swipe-down', 'swipe-left', 'swipe-right']
		const gestureType = gestureTypes[click[3]] || `type-${click[3]}`
		const screenName = (screen.an || '?').slice(0, 15)

		console.log(`  ${screenName.padEnd(17)} ${gestureType.padEnd(12)} @${clickTimeSec.toFixed(3)}s  frame #${String(videoFrame).padEnd(8)} drift: ${driftMs.toFixed(0)}ms  [${sev}]${!inRange ? ' [OUT OF SCREEN RANGE]' : ''}`)
	}
}

if (totalClicks === 0) {
	console.log('  (no clicks/gestures found)')
}
console.log()

// ─── Check 5: Frame Gaps ────────────────────────────────────────────────────

console.log('--- Frame Gaps (>500ms) ---')
const GAP_THRESHOLD_MS = 500
let gapCount = 0

for (let i = 1; i < allFrames.length; i++) {
	const gapMs = allFrames[i].time - allFrames[i - 1].time
	if (gapMs > GAP_THRESHOLD_MS) {
		gapCount++
		const fromSec = allFrames[i - 1].time / 1000
		const toSec = allFrames[i].time / 1000
		const duplicatedFrames = Math.floor(gapMs / (1000 / FPS))

		// Check if any screen transition falls in this gap
		const transitionsInGap = screenTimeline.filter((s) => {
			const atMs = s.at * 1000
			return atMs > allFrames[i - 1].time && atMs < allFrames[i].time
		})

		let extra = ''
		if (transitionsInGap.length > 0) {
			const names = transitionsInGap.map((s) => s.an).join(', ')
			extra = ` [WARN: screen transition during gap: ${names}]`
		}

		console.log(`  ${fromSec.toFixed(3)}s → ${toSec.toFixed(3)}s  (${gapMs.toFixed(0)}ms gap, ${duplicatedFrames} frozen video frames)${extra}`)
	}
}

if (gapCount === 0) {
	console.log('  (no gaps > 500ms)')
}
console.log()

// ─── Check 6: Batch Integrity ───────────────────────────────────────────────

console.log('--- Batch Integrity ---')
if (batchErrors.length === 0) {
	console.log(`  ${batchFiles.length} batches, all sequential and monotonic: OK`)
} else {
	for (const err of batchErrors) {
		console.log(`  [ERROR] ${err}`)
	}
}
console.log()

// ─── Summary ─────────────────────────────────────────────────────────────────

drifts.sort((a, b) => a - b)
const medianDrift = drifts.length > 0 ? drifts[Math.floor(drifts.length / 2)] : 0
const p95Drift = drifts.length > 0 ? drifts[Math.floor(drifts.length * 0.95)] : 0

console.log('=== Summary ===')
console.log(`  Max drift:    ${maxDrift.toFixed(0)}ms`)
console.log(`  Median drift: ${medianDrift.toFixed(0)}ms`)
console.log(`  P95 drift:    ${p95Drift.toFixed(0)}ms`)
console.log(`  Clicks:       ${totalClicks} total, ${clickIssues} out-of-range`)
console.log(`  Frame gaps:   ${gapCount} (>${GAP_THRESHOLD_MS}ms)`)
console.log(`  Batch errors: ${batchErrors.length}`)

const hasErrors = batchErrors.length > 0 || clickIssues > 0 || drifts.some((d) => d / 1000 > TOLERANCE_SEC * 3)
if (hasErrors) {
	console.log('\n  Result: ISSUES FOUND')
	process.exit(1)
} else {
	console.log('\n  Result: ALL OK')
}
