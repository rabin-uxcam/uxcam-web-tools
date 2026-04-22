/**
 * bin-processor.mjs — Local mirror of production bin-processor.ts
 *
 * 1:1 port of the production conversion pipeline with production-only
 * dependencies (logger, S3Service, Mongo, deleteFolder) replaced by
 * simple local equivalents. Every core function is kept identical so
 * this file can be used to validate the exact same conversion path.
 *
 * Usage from server.mjs:
 *   import { processBin } from './bin-processor.mjs'
 *   const result = await processBin(batchBuffers, sessionId, outputDir)
 */

import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, statSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import sharp from 'sharp'

// ─── Constants (matching bin-processor.ts) ────────────────────────────────────

const LAST_FRAME_HOLD_MS = 500

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Process batch buffers into an MP4 video.
 *
 * Mirrors BinProcessingService.process() from bin-processor.ts but writes
 * the video to a local output directory instead of uploading to S3.
 *
 * @param {{ name: string, buffer: Buffer }[]} batchBuffers
 * @param {string} sessionId
 * @param {string} outputDir - e.g. './output'
 * @param {{ sessionTotalMs?: number }} [opts] - optional; when provided, holds the
 *   last captured frame out to sessionTotalMs so the mp4 length matches session.tt
 * @returns {{ videoPath, frameCount, totalBatches, videoSizeBytes, dimensions }}
 */
export async function processBin(batchBuffers, sessionId, outputDir, opts = {}) {
	// a) Parse batch buffers → frames
	const { frames: allFrames, sessionEndMs: embeddedSessionEndMs } = parseBatchBuffers(batchBuffers)
	if (allFrames.length === 0) {
		console.log('[bin-processor] No frames found in batch buffers, returning')
		return null
	}

	// b) Sort frames by timestamp
	allFrames.sort((a, b) => a.time - b.time)

	// Prefer sessionEndMs embedded in the batch envelope (most accurate — stamped
	// by the SDK at flush time). Fall back to caller-provided opts.sessionTotalMs.
	const sessionTotalMs = embeddedSessionEndMs != null ? embeddedSessionEndMs : opts.sessionTotalMs

	const preCaptureGapMs = allFrames[0].time
	const lastFrameT = allFrames[allFrames.length - 1].time
	const captureSpanMs = lastFrameT - allFrames[0].time
	const tailHoldMs =
		sessionTotalMs != null ? Math.max(LAST_FRAME_HOLD_MS, sessionTotalMs - lastFrameT) : LAST_FRAME_HOLD_MS
	console.log(
		`[bin-processor] pre-capture gap: ${preCaptureGapMs}ms, ` +
			`capture span: ${captureSpanMs}ms, ` +
			`session total: ${sessionTotalMs != null ? `${sessionTotalMs}ms` : 'unknown'}` +
			`${embeddedSessionEndMs != null ? ' (embedded)' : ''}, ` +
			`tail hold: ${tailHoldMs}ms, ` +
			`video duration ≈ ${(lastFrameT + tailHoldMs) / 1000}s`,
	)

	// c) Resolve dimensions
	const { maxW, maxH, hasVaryingSizes } = await resolveDimensions(allFrames)
	console.log(`[bin-processor] ${allFrames.length} frames, ${maxW}x${maxH}${hasVaryingSizes ? ' (varying)' : ''}`)

	// d) Build effective timeline
	const effectiveTimes = buildEffectiveTimeline(allFrames)

	// e) Write frames to disk
	const workDir = join(outputDir, `${sessionId}-bin`, 'frames')
	mkdirSync(workDir, { recursive: true })

	try {
		await writeFrames(allFrames, workDir, maxW, maxH, hasVaryingSizes)

		// f) Build concat.txt
		const concatPath = join(workDir, 'concat.txt')
		writeFileSync(concatPath, buildConcatFile(allFrames.length, workDir, effectiveTimes), 'utf-8')

		// g) FFmpeg encode
		const outputVideo = join(outputDir, `${sessionId}-bin`, `${sessionId}.mp4`)
		console.log('[bin-processor] Starting FFmpeg encode')
		await runFfmpeg(concatPath, outputVideo, tailHoldMs)
		console.log('[bin-processor] FFmpeg encode complete')

		const videoSizeBytes = statSync(outputVideo).size

		return {
			videoPath: outputVideo,
			frameCount: allFrames.length,
			videoSizeBytes,
			dimensions: { width: maxW, height: maxH, hasVaryingSizes },
		}
	} finally {
		// h) Cleanup frames (keep the .mp4)
		if (existsSync(workDir)) {
			rmSync(workDir, { recursive: true })
		}
	}
}

// ─── Batch parsing (mirrors bin-processor.ts parseBatchBuffers) ──────────────

/**
 * Parse all batch buffers into frames.
 *
 * Wire format (produced by packBatch):
 *   [4-byte gzipped-JSON len (big-endian)][gzipped JSON metadata][raw WebP blobs]
 * Metadata payload (backward-compatible):
 *   v1 (legacy): [{ t, sz, w, h }, ...]
 *   v2 (envelope): { v: 2, meta: { sessionEndMs? }, frames: [{ t, sz, w, h }, ...] }
 *
 * The .bin files stored in S3 may be gzipped at the outer level,
 * so we attempt outer decompression first before parsing the inner binary format.
 *
 * @returns {{ frames: ParsedFrame[], sessionEndMs: number | null }}
 */
function parseBatchBuffers(batchBuffers) {
	const allFrames = []
	let sessionEndMs = null

	for (const { name, buffer } of batchBuffers) {
		console.log(`[bin-processor] Processing ${name} (${buffer.length} bytes)`)

		try {
			// Outer decompression — S3-stored .bin files may be gzipped at the outer level
			const raw = decompressBuffer(buffer)

			const gzippedJsonLen = raw.readUInt32BE(0)
			const gzippedJson = raw.subarray(4, 4 + gzippedJsonLen)
			const jsonBytes = gunzipSync(gzippedJson)
			const payload = JSON.parse(new TextDecoder().decode(jsonBytes))

			let frameMeta
			if (Array.isArray(payload)) {
				frameMeta = payload
			} else if (payload && payload.v === 2 && Array.isArray(payload.frames)) {
				frameMeta = payload.frames
				const envelope = payload.meta || {}
				if (typeof envelope.sessionEndMs === 'number') {
					sessionEndMs = sessionEndMs == null ? envelope.sessionEndMs : Math.max(sessionEndMs, envelope.sessionEndMs)
				}
			} else {
				throw new Error('Unknown batch metadata shape')
			}

			const dataStart = 4 + gzippedJsonLen
			let cursor = 0

			for (const f of frameMeta) {
				const frameData = raw.subarray(dataStart + cursor, dataStart + cursor + f.sz)
				cursor += f.sz
				allFrames.push({ time: f.t, width: f.w, height: f.h, data: Buffer.from(frameData) })
			}

			console.log(`[bin-processor] ${name}: ${frameMeta.length} frames extracted`)
		} catch (err) {
			console.warn(`[bin-processor] Failed to parse ${name}: ${err.message} — skipping`)
		}
	}

	console.log(`[bin-processor] Total: ${allFrames.length} frames from ${batchBuffers.length} file(s)`)
	return { frames: allFrames, sessionEndMs }
}

/** Try gunzip; return original buffer if not gzipped. */
function decompressBuffer(buffer) {
	try {
		return gunzipSync(buffer)
	} catch {
		return buffer
	}
}

// ─── Dimension resolution (mirrors bin-processor.ts resolveDimensions) ───────

async function resolveDimensions(allFrames) {
	// Backfill missing dimensions from first frame's WebP metadata
	if (allFrames.some((f) => f.width === 0 || f.height === 0)) {
		const meta = await sharp(allFrames[0].data).metadata()
		const fallbackW = meta.width || 0
		const fallbackH = meta.height || 0
		for (const f of allFrames) {
			if (f.width === 0) f.width = fallbackW
			if (f.height === 0) f.height = fallbackH
		}
	}

	let maxW = 0
	let maxH = 0
	for (const f of allFrames) {
		if (f.width > maxW) maxW = f.width
		if (f.height > maxH) maxH = f.height
	}

	// Codecs require even dimensions
	if (maxW % 2 !== 0) maxW++
	if (maxH % 2 !== 0) maxH++

	const hasVaryingSizes = allFrames.some((f) => f.width !== allFrames[0].width || f.height !== allFrames[0].height)

	return { maxW, maxH, hasVaryingSizes }
}

// ─── Timeline (mirrors bin-processor.ts buildEffectiveTimeline) ──────────────

// Frame `t` values are already session-relative (ms since session start;
// see DomCollector.getTime). Preserve the first frame's offset so the video
// length equals session duration — the pre-capture gap is held as a still
// on the first frame rather than erased.
function buildEffectiveTimeline(allFrames) {
	return allFrames.map((f) => f.time)
}

// ─── Frame writing (mirrors bin-processor.ts writeFrames) ────────────────────

async function writeFrames(allFrames, workDir, maxW, maxH, hasVaryingSizes) {
	// Resize when sizes vary OR when any source frame has odd dimensions
	// (maxW/maxH are already rounded to even by resolveDimensions)
	const needsResize = hasVaryingSizes || allFrames.some((f) => f.width % 2 !== 0 || f.height % 2 !== 0)

	for (let i = 0; i < allFrames.length; i++) {
		const framePath = join(workDir, `src-${String(i).padStart(5, '0')}.webp`)

		if (needsResize) {
			const frame = allFrames[i]
			const padBottom = Math.max(0, maxH - frame.height)
			const padRight = Math.max(0, maxW - frame.width)

			if (padBottom > 0 || padRight > 0) {
				// Center text in the larger visible gray strip (bottom or right)
				const bottomArea = maxW * padBottom
				const rightArea = padRight * frame.height
				let textX, textY
				if (bottomArea >= rightArea) {
					// Center in bottom strip
					textX = maxW / 2
					textY = frame.height + padBottom / 2
				} else {
					// Center in right strip
					textX = frame.width + padRight / 2
					textY = frame.height / 2
				}
				const fillerSvg = Buffer.from(
					`<svg width="${maxW}" height="${maxH}" xmlns="http://www.w3.org/2000/svg">
						<rect width="${maxW}" height="${maxH}" fill="rgb(193,195,197)"/>
						<text x="${textX}" y="${textY}"
							font-family="Arial, sans-serif" font-size="24" font-weight="bold"
							fill="#ffffff" text-anchor="middle" dominant-baseline="middle">
							Window Resized
						</text>
					</svg>`
				)
				const fillerBg = await sharp(fillerSvg).webp().toBuffer()

				// Composite the actual frame on top of the gray filler
				await sharp(fillerBg)
					.composite([{ input: frame.data, top: 0, left: 0 }])
					.webp({ quality: 100 })
					.toFile(framePath)
			} else {
				// Frame matches max dimensions but may have odd dimensions — just re-encode
				await sharp(frame.data).webp({ quality: 100 }).toFile(framePath)
			}
		} else {
			writeFileSync(framePath, allFrames[i].data)
		}
	}
}

// ─── Concat file (mirrors bin-processor.ts buildConcatFile) ──────────────────

function buildConcatFile(frameCount, workDir, effectiveTimes) {
	const lines = ['ffconcat version 1.0']

	// Hold the first captured frame for the pre-capture gap (effectiveTimes[0])
	// so the video starts at session t=0 and its total duration reflects
	// the real session length instead of only the captured span.
	const firstFramePath = join(workDir, `src-${String(0).padStart(5, '0')}.webp`)
	const preRollSec = effectiveTimes[0] / 1000
	if (preRollSec > 0) {
		lines.push(`file ${firstFramePath}`)
		lines.push(`duration ${preRollSec.toFixed(6)}`)
	}

	// Use the mean inter-frame gap as the last frame's nominal duration.
	// The ffconcat demuxer ignores the duration on the final entry, so this
	// value is just a positional placeholder for the sentinel repeat below.
	// Tail-holding past the last captured frame is done via `-vf tpad` in ffmpeg.
	const nominalLastMs = frameCount > 1 ? (effectiveTimes[frameCount - 1] - effectiveTimes[0]) / (frameCount - 1) : 100

	for (let i = 0; i < frameCount; i++) {
		const durationSec = i + 1 < frameCount ? (effectiveTimes[i + 1] - effectiveTimes[i]) / 1000 : nominalLastMs / 1000

		lines.push(`file ${join(workDir, `src-${String(i).padStart(5, '0')}.webp`)}`)
		lines.push(`duration ${durationSec.toFixed(6)}`)
	}

	// FFmpeg concat demuxer requires the last file repeated without duration
	lines.push(`file ${join(workDir, `src-${String(frameCount - 1).padStart(5, '0')}.webp`)}`)

	return lines.join('\n')
}

// ─── FFmpeg (mirrors bin-processor.ts runFfmpeg) ─────────────────────────────

function runFfmpeg(concatPath, outputVideo, tailHoldMs = LAST_FRAME_HOLD_MS) {
	return new Promise((resolve, reject) => {
		// ffconcat's last-entry `duration` is ignored by the demuxer (it only
		// positions the *next* file, and there is none). Use tpad to hold the
		// final frame for the remaining gap to session end.
		const tailHoldSec = (tailHoldMs / 1000).toFixed(6)
		const args = [
			'-y',
			'-f',
			'concat',
			'-safe',
			'0',
			'-i',
			concatPath,
			'-vf',
			`tpad=stop_mode=clone:stop_duration=${tailHoldSec}`,
			'-c:v',
			'libx265',
			'-pix_fmt',
			'yuv420p',
			'-vsync',
			'vfr',
			'-crf',
			'28',
			'-preset',
			'slower',
			'-tag:v',
			'hvc1',
			'-movflags',
			'+faststart',
			outputVideo,
		]

		const result = spawn('ffmpeg', args)
		let stderrChunks = []

		result.stderr.on('data', (data) => {
			stderrChunks.push(data)
		})

		result.on('close', (code) => {
			if (code !== 0) {
				const stderrOutput = Buffer.concat(stderrChunks).toString()
				return reject(new Error(`FFmpeg exited with code ${code}: ${stderrOutput}`))
			}
			return resolve()
		})

		result.on('error', (err) => {
			reject(new Error(`Failed to spawn ffmpeg: ${err.message}`))
		})
	})
}
