#!/usr/bin/env node

/**
 * analyze-timing.mjs
 *
 * Frame-level timing analyzer for canvas capture sessions.
 *
 * Given a set of batch .bin files, reconstructs the full per-frame timeline,
 * computes inter-frame gaps, flags stalls, and correlates stalls with session
 * events (if data.json is provided). The goal is to answer in one command:
 *
 *   "Is the 'video appears faster' problem coming from the capture side
 *    (timestamp gaps) or the conversion side (ffmpeg)?"
 *
 * Since bin-processor.mjs is already a faithful transform of frame.t → concat
 * duration, any pattern visible here is what the final video will look like.
 *
 * Inputs (any one):
 *   --session <id>                  pull batches from MinIO (uses server.mjs)
 *   --dir     <path>                local directory containing batch-*.bin files
 *   --bin     <path>                a single batch .bin file
 *   --concat  <path>                an existing concat.txt produced by bin-processor
 *                                   (timing only, dimensions unknown)
 *   --trace   <path>                per-frame console trace captured in the browser
 *                                   (enable via window.__uxcam_capture_trace = true)
 *                                   — gives main-thread bitmap time and worker time
 *
 * Optional:
 *   --events  <data.json>           session events, for stall correlation
 *   --json    <out.json>            machine-readable report
 *   --threshold <ms>                stall threshold (default: 500ms)
 *   --target-fps <n>                expected fps baseline (default: 3)
 *
 * Exit codes:
 *   0  clean (no stalls over threshold)
 *   1  stalls detected
 *   2  input error
 *
 * Usage examples:
 *   node analyze-timing.mjs --dir ./output/1776848298314-f5895df67985ca6a-bin
 *   node analyze-timing.mjs --session 1776848298314-f5895df67985ca6a --events ../../logs/data.json
 *   node analyze-timing.mjs --dir ./output/xxx-bin --json report.json
 */

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { parseBatch } from './parse-batch.mjs'

// ─── CLI parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const args = {}
	for (let i = 2; i < argv.length; i++) {
		const flag = argv[i]
		if (flag.startsWith('--')) {
			const key = flag.slice(2)
			const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
			args[key] = val
		}
	}
	return args
}

function usage() {
	console.log(`
Usage: node analyze-timing.mjs [options]

Input (choose one):
  --session <id>          Pull batches from MinIO via running server.mjs
  --dir <path>            Local directory containing batch-*.bin files
  --bin <path>            A single batch .bin file
  --concat <path>         An existing concat.txt (bin-processor output)

Optional:
  --events <data.json>    Session events for stall correlation
  --trace <path>          Per-frame console trace from the browser
                          (set window.__uxcam_capture_trace = true before SDK init)
  --json <out.json>       Write machine-readable report
  --threshold <ms>        Stall threshold in ms (default: 500)
  --target-fps <n>        Expected capture fps (default: 3)
  --server <url>          Server URL for --session (default: http://localhost:5505)
  --minio <url>           MinIO URL (default: http://localhost:9000)

Examples:
  node analyze-timing.mjs --dir ./output/<sessionId>-bin
  node analyze-timing.mjs --session abc --events ../../logs/data.json
`)
}

// ─── Batch loading ───────────────────────────────────────────────────────────

function loadBatchesFromDir(dirPath) {
	const abs = resolve(dirPath)
	if (!existsSync(abs) || !statSync(abs).isDirectory()) {
		throw new Error(`Not a directory: ${abs}`)
	}
	const binFiles = readdirSync(abs)
		.filter((f) => f.endsWith('.bin'))
		.sort()
	if (binFiles.length === 0) {
		throw new Error(`No .bin files found in ${abs}`)
	}
	return binFiles.map((name) => ({
		name,
		buffer: readFileSync(join(abs, name)),
	}))
}

function loadSingleBin(binPath) {
	const abs = resolve(binPath)
	if (!existsSync(abs)) throw new Error(`Not found: ${abs}`)
	return [{ name: basename(abs), buffer: readFileSync(abs) }]
}

function loadFramesFromConcat(concatPath) {
	const abs = resolve(concatPath)
	if (!existsSync(abs)) throw new Error(`Not found: ${abs}`)
	const lines = readFileSync(abs, 'utf-8').split('\n')
	const durations = lines
		.filter((l) => l.startsWith('duration '))
		.map((l) => parseFloat(l.slice(9)) * 1000)
	if (durations.length === 0) throw new Error(`No durations in ${abs}`)
	// bin-processor repeats the last file without duration — ignore last hold
	// by treating durations as inter-frame gaps starting at t=0
	const frames = [{ time: 0, width: 0, height: 0, bytes: 0, batch: 'concat' }]
	let t = 0
	for (let i = 0; i < durations.length - 1; i++) {
		t += durations[i]
		frames.push({ time: t, width: 0, height: 0, bytes: 0, batch: 'concat' })
	}
	return frames
}

async function loadBatchesFromServer({ sessionId, server, minio }) {
	const res = await fetch(`${server}/convert-bin`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ sessionId, minioUrl: minio }),
	})
	if (!res.ok) {
		const body = await res.text()
		throw new Error(`Server responded ${res.status}: ${body}`)
	}
	const { videoUrl } = await res.json()
	if (!videoUrl) throw new Error('No videoUrl in server response')

	const outputDir = resolve(import.meta.dirname || new URL('.', import.meta.url).pathname, 'output')
	const binDir = join(outputDir, `${sessionId}-bin`)
	return loadBatchesFromDir(binDir).catch(() => {
		throw new Error(`Conversion succeeded but bin dir ${binDir} is missing`)
	})
}

// ─── Unified batch decode (matches bin-processor.ts parseBatchBuffers) ────────

function extractFrames(batchBuffers) {
	const allFrames = []
	const startTimesByBin = new Map()
	for (const { name, buffer } of batchBuffers) {
		try {
			const raw = tryGunzip(buffer)
			const { frames } = parseBatch(raw)
			for (const f of frames) {
				allFrames.push({ time: f.time, width: f.width, height: f.height, bytes: f.data.length, batch: name, startTime: f.startTime })
			}
			const firstStart = frames[0]?.startTime
			if (typeof firstStart === 'number') startTimesByBin.set(name, firstStart)
		} catch (err) {
			console.error(`[analyze] skip ${name}: ${err.message}`)
		}
	}
	allFrames.sort((a, b) => a.time - b.time)
	reportStartTimes(startTimesByBin)
	return allFrames
}

function reportStartTimes(startTimesByBin) {
	if (startTimesByBin.size === 0) {
		console.log('[analyze] no startTime (s) field in any bin — running on legacy format')
		return
	}
	const uniques = new Set(startTimesByBin.values())
	if (uniques.size === 1) {
		const [s] = uniques
		console.log(`[analyze] startTime consistent across ${startTimesByBin.size} bin(s): ${s} (${new Date(s).toISOString()})`)
		return
	}
	console.error(`[analyze] ⚠ ${uniques.size} different startTimes across bins — timestamps will NOT align:`)
	for (const [name, s] of startTimesByBin) {
		console.error(`    ${name}: s=${s} (${new Date(s).toISOString()})`)
	}
}

function tryGunzip(buffer) {
	try {
		return gunzipSync(buffer)
	} catch {
		return buffer
	}
}

// ─── Trace loading ───────────────────────────────────────────────────────────

const TRACE_LINE = /\[uxcam-capture\]\s+t=(\d+)ms\s+bitmap=(-?\d+(?:\.\d+)?)\s+worker=(-?\d+(?:\.\d+)?)\s+kept=([01])\s+bytes=(\d+)/

function loadTrace(tracePath) {
	if (!tracePath || !existsSync(tracePath)) return null
	const text = readFileSync(tracePath, 'utf-8')
	const entries = []
	for (const line of text.split('\n')) {
		const m = line.match(TRACE_LINE)
		if (!m) continue
		entries.push({
			captureTime: parseInt(m[1], 10),
			bitmapMs: parseFloat(m[2]),
			workerMs: parseFloat(m[3]),
			kept: m[4] === '1',
			bytes: parseInt(m[5], 10),
		})
	}
	if (entries.length === 0) return null
	entries.sort((a, b) => a.captureTime - b.captureTime)
	return entries
}

function summarizeTrace(entries) {
	if (!entries) return null
	const kept = entries.filter((e) => e.kept)
	const skipped = entries.filter((e) => !e.kept)
	const pct = (arr, field, p) => {
		if (arr.length === 0) return 0
		const sorted = [...arr].map((e) => e[field]).sort((a, b) => a - b)
		return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
	}
	return {
		totalFrames: entries.length,
		keptFrames: kept.length,
		skippedFrames: skipped.length,
		bitmap: {
			p50: pct(entries, 'bitmapMs', 0.5),
			p95: pct(entries, 'bitmapMs', 0.95),
			p99: pct(entries, 'bitmapMs', 0.99),
			max: Math.max(...entries.map((e) => e.bitmapMs)),
		},
		worker: {
			p50: pct(entries, 'workerMs', 0.5),
			p95: pct(entries, 'workerMs', 0.95),
			p99: pct(entries, 'workerMs', 0.99),
			max: Math.max(...entries.map((e) => e.workerMs)),
		},
	}
}

function traceEntryFor(entries, captureTime, windowMs = 50) {
	if (!entries) return null
	let closest = null
	let closestDelta = Infinity
	for (const e of entries) {
		const delta = Math.abs(e.captureTime - captureTime)
		if (delta < closestDelta) {
			closestDelta = delta
			closest = e
		}
	}
	return closest && closestDelta <= windowMs ? closest : null
}

// ─── Event loading ───────────────────────────────────────────────────────────

function loadEvents(eventsPath) {
	if (!eventsPath || !existsSync(eventsPath)) return null
	try {
		const parsed = JSON.parse(readFileSync(eventsPath, 'utf-8'))
		const events = (parsed.evt || [])
			.map((e) => ({
				name: e.name,
				time: typeof e.time === 'number' ? e.time * 1000 : null,
				screen: e.screen,
				params: e.params,
			}))
			.filter((e) => e.time !== null)
			.sort((a, b) => a.time - b.time)
		const sessionDurationMs = parsed.session?.tt != null ? parsed.session.tt * 1000 : null
		return { events, sessionDurationMs }
	} catch (err) {
		console.error(`[analyze] failed to parse events: ${err.message}`)
		return null
	}
}

function findNearestEvent(events, timeMs, windowMs = 500) {
	if (!events || events.length === 0) return null
	let closest = null
	let closestDelta = Infinity
	for (const e of events) {
		const delta = Math.abs(e.time - timeMs)
		if (delta < closestDelta) {
			closestDelta = delta
			closest = e
		}
	}
	if (closest && closestDelta <= windowMs) {
		return { ...closest, deltaMs: closestDelta }
	}
	return null
}

// ─── Analysis ────────────────────────────────────────────────────────────────

function analyze(frames, { thresholdMs, targetFps, eventsData, traceEntries }) {
	const firstT = frames[0]?.time ?? 0
	const lastT = frames[frames.length - 1]?.time ?? 0
	const spanMs = lastT - firstT
	const expectedFrames = Math.round((spanMs / 1000) * targetFps) + 1
	const missingFrames = Math.max(0, expectedFrames - frames.length)
	const effectiveFps = frames.length / Math.max(1, spanMs / 1000)
	const targetGapMs = 1000 / targetFps

	const gaps = []
	for (let i = 1; i < frames.length; i++) {
		const gap = frames[i].time - frames[i - 1].time
		gaps.push({
			index: i,
			fromTime: frames[i - 1].time,
			toTime: frames[i].time,
			gapMs: gap,
			isStall: gap > thresholdMs,
			missedFrames: Math.max(0, Math.round(gap / targetGapMs) - 1),
		})
	}

	const stalls = gaps
		.filter((g) => g.isStall)
		.map((g) => ({
			...g,
			nearestEvent: eventsData
				? findNearestEvent(eventsData.events, g.fromTime, 750)
				: null,
			traceFrom: traceEntryFor(traceEntries, g.fromTime),
			traceTo: traceEntryFor(traceEntries, g.toTime),
		}))

	const histogram = bucketize(gaps.map((g) => g.gapMs), targetGapMs)

	return {
		frameCount: frames.length,
		firstTimestampMs: firstT,
		lastTimestampMs: lastT,
		spanMs,
		spanSeconds: spanMs / 1000,
		expectedFrames,
		missingFrames,
		effectiveFps,
		targetFps,
		targetGapMs,
		stalls,
		totalStalls: stalls.length,
		worstStallMs: stalls.reduce((m, s) => Math.max(m, s.gapMs), 0),
		histogram,
	}
}

function bucketize(values, targetGapMs) {
	const buckets = [
		{ label: `≤${(targetGapMs * 1.1).toFixed(0)}ms (clean)`, max: targetGapMs * 1.1 },
		{ label: `≤${(targetGapMs * 2).toFixed(0)}ms (1 skip)`, max: targetGapMs * 2 },
		{ label: `≤${(targetGapMs * 3).toFixed(0)}ms (2 skips)`, max: targetGapMs * 3 },
		{ label: `≤${(targetGapMs * 5).toFixed(0)}ms (4 skips)`, max: targetGapMs * 5 },
		{ label: `>${(targetGapMs * 5).toFixed(0)}ms (5+ skips)`, max: Infinity },
	]
	const counts = buckets.map(() => 0)
	for (const v of values) {
		for (let i = 0; i < buckets.length; i++) {
			if (v <= buckets[i].max) {
				counts[i]++
				break
			}
		}
	}
	return buckets.map((b, i) => ({ label: b.label, count: counts[i] }))
}

// ─── Reporting ───────────────────────────────────────────────────────────────

function pad(str, n) {
	const s = String(str)
	return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function printReport(result, { eventsData, thresholdMs, traceSummary }) {
	const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) + '%' : '0%')
	console.log('')
	console.log('═══════════════════════════════════════════════════════════════════')
	console.log('  Canvas Capture Timing Report')
	console.log('═══════════════════════════════════════════════════════════════════')
	console.log(`  Frames captured          : ${result.frameCount}`)
	console.log(`  Expected (@ ${result.targetFps} fps)   : ${result.expectedFrames}`)
	console.log(`  Missing                  : ${result.missingFrames}  (${pct(result.missingFrames, result.expectedFrames)})`)
	console.log(`  Time span                : ${result.spanSeconds.toFixed(3)}s`)
	console.log(`  Effective fps            : ${result.effectiveFps.toFixed(2)}  (target ${result.targetFps})`)
	if (eventsData?.sessionDurationMs != null) {
		const sessionSec = eventsData.sessionDurationMs / 1000
		const delta = result.spanSeconds - sessionSec
		console.log(`  Session duration (tt)    : ${sessionSec.toFixed(3)}s  (frame span Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}s)`)
	}
	console.log('')

	if (traceSummary) {
		console.log(`  Browser trace             (${traceSummary.totalFrames} entries, ${traceSummary.skippedFrames} deduped):`)
		console.log(`    createImageBitmap       p50=${traceSummary.bitmap.p50.toFixed(1)}ms  p95=${traceSummary.bitmap.p95.toFixed(1)}ms  p99=${traceSummary.bitmap.p99.toFixed(1)}ms  max=${traceSummary.bitmap.max.toFixed(1)}ms`)
		console.log(`    worker round-trip       p50=${traceSummary.worker.p50.toFixed(1)}ms  p95=${traceSummary.worker.p95.toFixed(1)}ms  p99=${traceSummary.worker.p99.toFixed(1)}ms  max=${traceSummary.worker.max.toFixed(1)}ms`)
		console.log('')
	}

	console.log(`  Gap distribution (threshold ${thresholdMs}ms):`)
	for (const bucket of result.histogram) {
		const bar = '█'.repeat(Math.round(bucket.count / 2))
		console.log(`    ${pad(bucket.label, 28)} ${pad(bucket.count, 4)} ${bar}`)
	}
	console.log('')

	if (result.totalStalls === 0) {
		console.log('  ✓ No stalls detected above threshold.')
	} else {
		console.log(`  Stalls (${result.totalStalls} total, worst ${result.worstStallMs.toFixed(0)}ms):`)
		const sorted = [...result.stalls].sort((a, b) => b.gapMs - a.gapMs)
		const topN = sorted.slice(0, 20)
		console.log('')
		const hasTrace = topN.some((s) => s.traceFrom || s.traceTo)
		const traceHead = hasTrace ? `${pad('bmpA', 8)}${pad('wrkA', 8)}${pad('bmpB', 8)}${pad('wrkB', 8)}` : ''
		console.log(`    ${pad('#', 5)}${pad('at(s)', 10)}${pad('gap(ms)', 10)}${pad('skipped', 10)}${traceHead}nearest event`)
		console.log(`    ${'─'.repeat(5 + 10 + 10 + 10 + (hasTrace ? 32 : 0))}─────────────`)
		for (const s of topN) {
			const at = (s.fromTime / 1000).toFixed(3)
			const ev = s.nearestEvent
				? `${s.nearestEvent.name}  (Δ${s.nearestEvent.deltaMs.toFixed(0)}ms)  ${s.nearestEvent.screen || ''}`
				: ''
			const fmt = (n) => (n == null ? '·' : n.toFixed(0))
			const traceCols = hasTrace
				? `${pad(fmt(s.traceFrom?.bitmapMs), 8)}${pad(fmt(s.traceFrom?.workerMs), 8)}${pad(fmt(s.traceTo?.bitmapMs), 8)}${pad(fmt(s.traceTo?.workerMs), 8)}`
				: ''
			console.log(
				`    ${pad(s.index, 5)}${pad(at, 10)}${pad(s.gapMs.toFixed(0), 10)}${pad(s.missedFrames, 10)}${traceCols}${ev}`
			)
		}
		if (sorted.length > topN.length) {
			console.log(`    … ${sorted.length - topN.length} more`)
		}
	}

	console.log('')
	console.log('  Verdict:')
	const verdict = diagnose(result, eventsData, traceSummary)
	for (const line of verdict) console.log(`    ${line}`)
	console.log('═══════════════════════════════════════════════════════════════════')
	console.log('')
}

function diagnose(result, eventsData, traceSummary) {
	const lines = []
	const stallFrac = result.totalStalls / Math.max(1, result.frameCount - 1)

	if (result.totalStalls === 0) {
		lines.push('No capture-side timing issue. If video still appears fast, look elsewhere.')
		return lines
	}

	if (stallFrac > 0.3) {
		lines.push('Widespread stalls — pipeline is not keeping up consistently.')
		lines.push('Check: worker encode cost, adaptive throttle logic, document.hidden state.')
	} else if (stallFrac > 0.1) {
		lines.push('Localized stalls — capture loop blocks at specific moments.')
	} else {
		lines.push('Occasional stalls — tolerable but real.')
	}

	if (result.worstStallMs > 1500) {
		lines.push(`Worst stall ${result.worstStallMs.toFixed(0)}ms — likely a main-thread block or GPU readback (createImageBitmap).`)
	}

	if (eventsData) {
		const nav = result.stalls.filter(
			(s) => s.nearestEvent && s.nearestEvent.name === 'uxc_url_navigate'
		).length
		if (nav / Math.max(1, result.totalStalls) > 0.3) {
			lines.push(`${nav}/${result.totalStalls} stalls coincide with navigations — Flutter scene transitions are stalling createImageBitmap.`)
		}
	}

	if (result.missingFrames / Math.max(1, result.expectedFrames) > 0.1) {
		lines.push(
			`Capture rate ${result.effectiveFps.toFixed(2)} fps vs target ${result.targetFps} — motion will render as undersampled even though duration is correct.`
		)
	}

	if (traceSummary) {
		const bmpHot = traceSummary.bitmap.p95 > 150 || traceSummary.bitmap.max > 500
		const wrkHot = traceSummary.worker.p95 > 150 || traceSummary.worker.max > 500
		if (bmpHot && !wrkHot) {
			lines.push(
				`createImageBitmap dominates (p95 ${traceSummary.bitmap.p95.toFixed(0)}ms, max ${traceSummary.bitmap.max.toFixed(0)}ms) — main-thread GPU readback is the bottleneck. Worker is idle waiting.`
			)
		} else if (wrkHot && !bmpHot) {
			lines.push(
				`Worker round-trip dominates (p95 ${traceSummary.worker.p95.toFixed(0)}ms, max ${traceSummary.worker.max.toFixed(0)}ms) — encode/dedup is the bottleneck. Consider a second worker or lower WebP quality.`
			)
		} else if (bmpHot && wrkHot) {
			lines.push(
				`Both stages are slow (bitmap p95 ${traceSummary.bitmap.p95.toFixed(0)}ms, worker p95 ${traceSummary.worker.p95.toFixed(0)}ms) — pipeline depth 2 is needed but insufficient.`
			)
		} else {
			lines.push(
				`Bitmap p95 ${traceSummary.bitmap.p95.toFixed(0)}ms + worker p95 ${traceSummary.worker.p95.toFixed(0)}ms — neither stage is hot. Stalls likely from missed RAF ticks (long tasks, tab throttling).`
			)
		}
	} else {
		lines.push('Run again with --trace <path> to attribute stalls to bitmap vs worker.')
	}

	return lines
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	const args = parseArgs(process.argv)
	if (args.help || args.h) {
		usage()
		process.exit(0)
	}

	const thresholdMs = parseInt(args.threshold || '500', 10)
	const targetFps = parseFloat(args['target-fps'] || '3')
	const server = args.server || 'http://localhost:5505'
	const minio = args.minio || 'http://localhost:9000'

	let frames
	try {
		if (args.concat) {
			frames = loadFramesFromConcat(args.concat)
			console.log(`[analyze] loaded ${frames.length} frame timestamps from concat.txt`)
		} else {
			let batches
			if (args.dir) {
				batches = loadBatchesFromDir(args.dir)
			} else if (args.bin) {
				batches = loadSingleBin(args.bin)
			} else if (args.session) {
				console.log(`[analyze] fetching session ${args.session} via ${server}...`)
				batches = await loadBatchesFromServer({ sessionId: args.session, server, minio })
			} else {
				usage()
				process.exit(2)
			}
			console.log(`[analyze] loaded ${batches.length} batch file(s), total ${batches.reduce((s, b) => s + b.buffer.length, 0)} bytes`)
			frames = extractFrames(batches)
		}
	} catch (err) {
		console.error(`[analyze] input error: ${err.message}`)
		process.exit(2)
	}
	if (frames.length === 0) {
		console.error('[analyze] no frames extracted')
		process.exit(2)
	}

	const eventsData = loadEvents(args.events)
	const traceEntries = loadTrace(args.trace)
	const traceSummary = summarizeTrace(traceEntries)
	if (args.trace && !traceEntries) {
		console.error(`[analyze] trace file ${args.trace} had no matching lines — check the format`)
	}
	const result = analyze(frames, { thresholdMs, targetFps, eventsData, traceEntries })

	printReport(result, { eventsData, thresholdMs, traceSummary })

	if (args.json) {
		writeFileSync(args.json, JSON.stringify({ ...result, frames, traceSummary }, null, 2))
		console.log(`[analyze] wrote ${args.json}`)
	}

	process.exit(result.totalStalls > 0 ? 1 : 0)
}

main().catch((err) => {
	console.error(`[analyze] fatal: ${err.stack || err.message}`)
	process.exit(2)
})
