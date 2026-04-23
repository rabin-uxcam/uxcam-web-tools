#!/usr/bin/env node

/**
 * speed-test.mjs — "Is the video faster than real time?" in one command.
 *
 * Pulls canvas .bin files (from MinIO or a local dir), extracts the frame
 * timeline, runs the production bin-processor to produce the MP4, then
 * compares three durations:
 *
 *   A. Frame span       — last frame.t minus first frame.t (capture side)
 *   B. MP4 duration     — ffprobe of the generated file  (encode side)
 *   C. Session.tt       — session duration from data.json (ground truth)
 *   D. Stopwatch (opt)  — human-measured real-world recording length
 *
 * The verdict identifies exactly which stage compressed time.
 *
 * Usage:
 *   node speed-test.mjs --session <id>                      # pull from MinIO
 *   node speed-test.mjs --dir ./output/<sid>-bin            # local bins
 *   node speed-test.mjs --session <id> --events data.json   # add ground truth
 *   node speed-test.mjs --session <id> --stopwatch 47.5     # add real-world time
 *
 * Options:
 *   --minio <url>       MinIO URL (default: http://localhost:9000)
 *   --bucket <name>     MinIO bucket (default: uxcam-sessions)
 *   --prefix <path>     Canvas prefix (default: sessions/canvas/)
 *   --access <key>      MinIO access key (default: minioadmin)
 *   --secret <key>      MinIO secret key (default: minioadmin)
 *   --tolerance <pct>   Mismatch tolerance in % (default: 3)
 *   --json <path>       Write machine-readable report
 *   --keep              Keep downloaded bins on disk (default: cleaned)
 *
 * Exit codes:
 *   0  clean — all durations agree within tolerance
 *   1  mismatch detected (verdict printed)
 *   2  input error
 */

import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { parseBatch } from './parse-batch.mjs'
import { processBin } from './bin-processor.mjs'
import { createS3Client, listBatchFiles, downloadObject } from './index.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_OUTPUT = resolve(__dirname, 'output')

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const args = {}
	for (let i = 2; i < argv.length; i++) {
		const flag = argv[i]
		if (!flag.startsWith('--')) continue
		const key = flag.slice(2)
		const next = argv[i + 1]
		const val = next && !next.startsWith('--') ? (i++, next) : true
		args[key] = val
	}
	return args
}

function usage() {
	console.log(`
Usage: node speed-test.mjs [options]

Input (choose one):
  --session <id>          Pull batches from MinIO
  --dir <path>            Local directory containing batch-*.bin files

Optional:
  --events <data.json>    Session data for ground-truth (session.tt)
  --stopwatch <seconds>   Human-measured real-world recording length
  --minio <url>           MinIO URL (default: http://localhost:9000)
  --bucket <name>         Bucket name (default: uxcam-sessions)
  --prefix <path>         Canvas prefix (default: sessions/canvas/)
  --access <key>          MinIO access key (default: minioadmin)
  --secret <key>          MinIO secret key (default: minioadmin)
  --tolerance <pct>       Mismatch tolerance, default 3
  --json <out.json>       Write machine-readable report
  --keep                  Keep downloaded bins (default: cleaned)
  --no-anchor             Disable session-bounds anchoring (legacy behavior)

Examples:
  node speed-test.mjs --dir ./output/1775028173327-717ac7b772cedba2-bin
  node speed-test.mjs --session abc --events ../../logs/data.json --stopwatch 47
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
		throw new Error(`No .bin files in ${abs}`)
	}
	return binFiles.map((name) => ({ name, buffer: readFileSync(join(abs, name)) }))
}

async function loadBatchesFromMinio(args) {
	const s3 = createS3Client({
		endpoint: args.minio || 'http://localhost:9000',
		accessKey: args.access || 'minioadmin',
		secretKey: args.secret || 'minioadmin',
	})
	const bucket = args.bucket || 'uxcam-sessions'
	const canvasPrefix = args.prefix || 'sessions/canvas/'
	const sessionPrefix = `${canvasPrefix}${args.session}/`

	const objects = await listBatchFiles(s3, sessionPrefix, { bucket })
	if (objects.length === 0) {
		throw new Error(`No batch files at ${bucket}/${sessionPrefix}`)
	}
	console.log(`[speed-test] Downloading ${objects.length} batch file(s)…`)

	const batches = []
	for (const obj of objects) {
		const buffer = await downloadObject(s3, obj.Key, { bucket })
		batches.push({ name: basename(obj.Key), buffer })
	}
	return batches
}

// ─── Frame extraction ────────────────────────────────────────────────────────

function extractFrames(batchBuffers) {
	const frames = []
	for (const { name, buffer } of batchBuffers) {
		try {
			const raw = tryGunzip(buffer)
			const { frames: decoded } = parseBatch(raw)
			for (const f of decoded) {
				frames.push({ time: f.time, width: f.width, height: f.height, bytes: f.data.length, batch: name })
			}
		} catch (err) {
			console.error(`[speed-test] skip ${name}: ${err.message}`)
		}
	}
	frames.sort((a, b) => a.time - b.time)
	return frames
}

function tryGunzip(buffer) {
	try {
		return gunzipSync(buffer)
	} catch {
		return buffer
	}
}

// ─── Events ─────────────────────────────────────────────────────────────────

function loadSessionTt(eventsPath) {
	if (!eventsPath) return null
	const abs = resolve(eventsPath)
	if (!existsSync(abs)) {
		console.error(`[speed-test] events file not found: ${abs}`)
		return null
	}
	try {
		const parsed = JSON.parse(readFileSync(abs, 'utf-8'))
		const ttSec = parsed.session?.tt
		return typeof ttSec === 'number' ? ttSec : null
	} catch (err) {
		console.error(`[speed-test] failed to parse events: ${err.message}`)
		return null
	}
}

// Derive a session-end hint (ms, session-relative) from the most confident source.
// Order: session.tt → max(event.time) → null.
function deriveEndMsHint(eventsPath) {
	if (!eventsPath) return null
	const abs = resolve(eventsPath)
	if (!existsSync(abs)) return null
	try {
		const parsed = JSON.parse(readFileSync(abs, 'utf-8'))
		const ttSec = parsed.session?.tt
		if (typeof ttSec === 'number') return ttSec * 1000

		const events = parsed.evt || []
		let maxT = 0
		for (const e of events) {
			const t = typeof e.time === 'number' ? e.time * 1000 : null
			if (t != null && t > maxT) maxT = t
		}
		return maxT > 0 ? maxT : null
	} catch {
		return null
	}
}

// ─── ffprobe ────────────────────────────────────────────────────────────────

function ffprobeDuration(mp4Path) {
	return new Promise((resolveFn, rejectFn) => {
		const proc = spawn('ffprobe', [
			'-v', 'error',
			'-show_entries', 'format=duration',
			'-of', 'default=noprint_wrappers=1:nokey=1',
			mp4Path,
		])
		let stdout = ''
		let stderr = ''
		proc.stdout.on('data', (c) => (stdout += c))
		proc.stderr.on('data', (c) => (stderr += c))
		proc.on('close', (code) => {
			if (code !== 0) return rejectFn(new Error(`ffprobe exit ${code}: ${stderr}`))
			const secs = parseFloat(stdout.trim())
			if (!Number.isFinite(secs)) return rejectFn(new Error(`ffprobe parse: "${stdout}"`))
			resolveFn(secs)
		})
		proc.on('error', (err) => rejectFn(new Error(`spawn ffprobe: ${err.message}`)))
	})
}

// ─── Reporting ──────────────────────────────────────────────────────────────

function fmtSec(sec) {
	if (sec == null) return '—'
	return `${sec.toFixed(3)}s`
}

function fmtDelta(actual, ref) {
	if (actual == null || ref == null || ref === 0) return '—'
	const delta = actual - ref
	const pct = (delta / ref) * 100
	const sign = delta >= 0 ? '+' : ''
	return `${sign}${delta.toFixed(3)}s (${sign}${pct.toFixed(1)}%)`
}

function withinTolerance(a, b, tolerancePct) {
	if (a == null || b == null) return null
	if (b === 0) return a === 0
	const pct = Math.abs((a - b) / b) * 100
	return pct <= tolerancePct
}

function printReport({ sessionId, frameCount, frameSpanSec, mp4DurationSec, sessionTtSec, stopwatchSec, tolerancePct, firstFrameMs, lastFrameMs }) {
	const line = '─'.repeat(67)
	console.log('')
	console.log('═'.repeat(67))
	console.log(`  Canvas Speed Test — ${sessionId || 'local'}`)
	console.log('═'.repeat(67))
	console.log(`  Frames                   : ${frameCount}`)
	console.log(`  First frame.t            : ${firstFrameMs} ms`)
	console.log(`  Last  frame.t            : ${lastFrameMs} ms`)
	console.log(line)
	console.log(`  A. Frame span   (capture): ${fmtSec(frameSpanSec)}`)
	console.log(`  B. MP4 duration (ffprobe): ${fmtSec(mp4DurationSec)}`)
	console.log(`  C. Session.tt   (truth)  : ${fmtSec(sessionTtSec)}`)
	console.log(`  D. Stopwatch    (human)  : ${fmtSec(stopwatchSec)}`)
	console.log(line)

	if (sessionTtSec != null) {
		console.log(`  A vs C   frame_span − tt      : ${fmtDelta(frameSpanSec, sessionTtSec)}`)
		console.log(`  B vs C   mp4 − tt             : ${fmtDelta(mp4DurationSec, sessionTtSec)}`)
	}
	console.log(`  B vs A   mp4 − frame_span     : ${fmtDelta(mp4DurationSec, frameSpanSec)}`)
	if (stopwatchSec != null) {
		console.log(`  A vs D   frame_span − stopwatch: ${fmtDelta(frameSpanSec, stopwatchSec)}`)
		console.log(`  B vs D   mp4 − stopwatch       : ${fmtDelta(mp4DurationSec, stopwatchSec)}`)
	}
	console.log('')

	const verdict = diagnose({ frameSpanSec, mp4DurationSec, sessionTtSec, stopwatchSec, tolerancePct })
	console.log(`  Verdict (tolerance ±${tolerancePct}%):`)
	for (const l of verdict.lines) console.log(`    ${l}`)
	console.log('═'.repeat(67))
	console.log('')
	return verdict
}

function diagnose({ frameSpanSec, mp4DurationSec, sessionTtSec, stopwatchSec, tolerancePct }) {
	const lines = []
	let ok = true

	const encodeOk = withinTolerance(mp4DurationSec, frameSpanSec, tolerancePct)
	if (encodeOk === false) {
		ok = false
		const direction = mp4DurationSec < frameSpanSec ? 'shorter' : 'longer'
		lines.push(`❌ MP4 is ${direction} than the frame span — the encode compressed/stretched time.`)
		lines.push(`   Look at bin-processor.mjs buildConcatFile + runFfmpeg (-vsync vfr).`)
	} else if (encodeOk === true) {
		lines.push(`✓  MP4 duration matches frame span — encode side is faithful.`)
	}

	const truth = sessionTtSec ?? stopwatchSec
	const truthLabel = sessionTtSec != null ? 'session.tt' : stopwatchSec != null ? 'stopwatch' : null

	if (truth != null) {
		const captureOk = withinTolerance(frameSpanSec, truth, tolerancePct)
		if (captureOk === false) {
			ok = false
			const direction = frameSpanSec < truth ? 'shorter' : 'longer'
			lines.push(`❌ Frame span is ${direction} than ${truthLabel} — the capture side compressed/stretched time.`)
			lines.push(`   Look at FlutterCanvasManager timestamp emission: is frame.t relative to session start?`)
			lines.push(`   Check for: re-anchoring to first captured frame; using performance.now() vs Date.now() mismatch; batch-level re-numbering.`)
		} else if (captureOk === true) {
			lines.push(`✓  Frame span matches ${truthLabel} — capture side is faithful.`)
		}

		const mp4Ok = withinTolerance(mp4DurationSec, truth, tolerancePct)
		if (mp4Ok === true && encodeOk !== false) {
			lines.push(`✓  MP4 duration matches ${truthLabel} — playback pacing is real-time.`)
		} else if (mp4Ok === false) {
			ok = false
			const direction = mp4DurationSec < truth ? 'shorter (faster playback)' : 'longer (slower playback)'
			lines.push(`❌ MP4 is ${direction} than ${truthLabel}.`)
			if (encodeOk !== false) {
				lines.push(`   Since encode is faithful, the root cause is on capture: timestamps don't cover the full session.`)
			}
		}
	} else {
		lines.push(`(no ground truth — pass --events data.json or --stopwatch <sec> to decide whether capture is accurate)`)
	}

	if (lines.length === 0) {
		lines.push('No diagnosis available.')
	}
	return { lines, ok }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
	const args = parseArgs(process.argv)
	if (args.help || args.h) {
		usage()
		process.exit(0)
	}
	if (!args.session && !args.dir) {
		usage()
		process.exit(2)
	}

	const tolerancePct = parseFloat(args.tolerance || '3')
	const keep = !!args.keep

	// 1. Load batches
	let batches
	let sessionId = args.session || null
	let downloadedDir = null
	try {
		if (args.dir) {
			batches = loadBatchesFromDir(args.dir)
			sessionId = sessionId || basename(resolve(args.dir)).replace(/-bin$/, '')
		} else {
			batches = await loadBatchesFromMinio(args)
			downloadedDir = join(DEFAULT_OUTPUT, `${sessionId}-bin`)
			mkdirSync(downloadedDir, { recursive: true })
			for (const b of batches) {
				writeFileSync(join(downloadedDir, b.name), b.buffer)
			}
		}
	} catch (err) {
		console.error(`[speed-test] input error: ${err.message}`)
		process.exit(2)
	}

	console.log(`[speed-test] loaded ${batches.length} batch(es), total ${batches.reduce((s, b) => s + b.buffer.length, 0)} bytes`)

	// 2. Extract frame timeline
	const frames = extractFrames(batches)
	if (frames.length === 0) {
		console.error('[speed-test] no frames extracted')
		process.exit(2)
	}
	const firstFrameMs = frames[0].time
	const lastFrameMs = frames[frames.length - 1].time
	const frameSpanSec = (lastFrameMs - firstFrameMs) / 1000

	// 3. Encode via production pipeline, anchoring to session bounds when available.
	//    Use --no-anchor to reproduce legacy behavior for comparison.
	const endMsHint = args['no-anchor'] ? null : deriveEndMsHint(args.events)
	const startMs = args['no-anchor'] ? null : (endMsHint != null ? 0 : null)
	const bounds = {}
	if (startMs != null) bounds.startMs = startMs
	if (endMsHint != null) bounds.endMsHint = endMsHint
	if (bounds.endMsHint != null) {
		console.log(`[speed-test] anchoring tail to endMsHint=${bounds.endMsHint}ms (from events)`)
	}
	console.log('[speed-test] running bin-processor…')
	const result = await processBin(batches, sessionId, DEFAULT_OUTPUT, bounds)
	if (!result) {
		console.error('[speed-test] processBin returned no result')
		process.exit(2)
	}

	// 4. ffprobe the output
	let mp4DurationSec = null
	try {
		mp4DurationSec = await ffprobeDuration(result.videoPath)
	} catch (err) {
		console.error(`[speed-test] ffprobe failed: ${err.message}`)
	}

	// 5. Ground-truth inputs
	const sessionTtSec = loadSessionTt(args.events)
	const stopwatchSec = args.stopwatch ? parseFloat(args.stopwatch) : null

	// 6. Report
	const verdict = printReport({
		sessionId,
		frameCount: frames.length,
		firstFrameMs,
		lastFrameMs,
		frameSpanSec,
		mp4DurationSec,
		sessionTtSec,
		stopwatchSec,
		tolerancePct,
	})

	console.log(`  MP4: ${result.videoPath}`)
	console.log(`  MP4 size: ${(result.videoSizeBytes / 1024).toFixed(1)} KB`)
	console.log('')

	// 7. Optional JSON report
	if (args.json) {
		const payload = {
			sessionId,
			frameCount: frames.length,
			firstFrameMs,
			lastFrameMs,
			frameSpanSec,
			mp4DurationSec,
			mp4Path: result.videoPath,
			mp4SizeBytes: result.videoSizeBytes,
			sessionTtSec,
			stopwatchSec,
			tolerancePct,
			verdict: verdict.lines,
			ok: verdict.ok,
		}
		writeFileSync(args.json, JSON.stringify(payload, null, 2))
		console.log(`[speed-test] wrote ${args.json}`)
	}

	// 8. Cleanup downloaded bins if requested
	if (downloadedDir && !keep) {
		try { rmSync(downloadedDir, { recursive: true, force: true }) } catch { /* noop */ }
	}

	process.exit(verdict.ok ? 0 : 1)
}

main().catch((err) => {
	console.error(`[speed-test] fatal: ${err.stack || err.message}`)
	process.exit(2)
})
