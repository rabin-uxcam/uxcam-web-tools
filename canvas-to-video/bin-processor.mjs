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
import { parseBatch } from './parse-batch.mjs'

// ─── Constants (matching bin-processor.ts) ────────────────────────────────────

const FRAME_QUALITY = 80
const FALLBACK_LAST_FRAME_HOLD_MS = 50

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
 * @returns {{ videoPath, frameCount, totalBatches, videoSizeBytes, dimensions }}
 */
export async function processBin(batchBuffers, sessionId, outputDir) {
	// a) Parse batch buffers → frames
	const parsedFrames = parseBatchBuffers(batchBuffers)
	if (parsedFrames.length === 0) {
		console.log('[bin-processor] No frames found in batch buffers, returning')
		return null
	}

	// b) Sort by timestamp, then split out end-markers (sz=0 sentinel frames)
	parsedFrames.sort((a, b) => a.time - b.time)
	const { allFrames, endMarkerTime } = extractEndMarker(parsedFrames)

	if (allFrames.length === 0) {
		console.log('[bin-processor] Only end markers found (no real frames), returning')
		return null
	}

	// c) Resolve dimensions
	const { maxW, maxH } = await resolveDimensions(allFrames)
	console.log(`[bin-processor] ${allFrames.length} frames, ${maxW}x${maxH}`)

	// d) Build effective timeline
	const effectiveTimes = buildEffectiveTimeline(allFrames)

	// e) Write frames to disk
	const workDir = join(outputDir, `${sessionId}-bin`, 'frames')
	mkdirSync(workDir, { recursive: true })

	try {
		await writeFrames(allFrames, workDir)

		// f) Build concat.txt — use end-marker to hold the last frame until session end
		const lastFrameHoldMs = computeLastFrameHoldMs(allFrames, endMarkerTime)
		const concatPath = join(workDir, 'concat.txt')
		writeFileSync(concatPath, buildConcatFile(allFrames.length, workDir, effectiveTimes, lastFrameHoldMs), 'utf-8')

		// g) FFmpeg encode
		const outputVideo = join(outputDir, `${sessionId}-bin`, `${sessionId}.mp4`)
		console.log('[bin-processor] Starting FFmpeg encode')
		await runFfmpeg(concatPath, outputVideo, maxW, maxH)
		console.log('[bin-processor] FFmpeg encode complete')

		const videoSizeBytes = statSync(outputVideo).size

		return {
			videoPath: outputVideo,
			frameCount: allFrames.length,
			videoSizeBytes,
			dimensions: { width: maxW, height: maxH },
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
 *   JSON: [{ t, sz, w, h }, ...]
 *
 * The .bin files stored in S3 may be gzipped at the outer level,
 * so we attempt outer decompression first before parsing the inner binary format.
 */
function parseBatchBuffers(batchBuffers) {
	const allFrames = []

	for (const { name, buffer } of batchBuffers) {
		console.log(`[bin-processor] Processing ${name} (${buffer.length} bytes)`)

		try {
			const raw = decompressBuffer(buffer)
			const { frames } = parseBatch(raw)

			for (const f of frames) {
				allFrames.push({ time: f.time, width: f.width, height: f.height, data: f.data })
			}

			console.log(`[bin-processor] ${name}: ${frames.length} frames extracted`)
		} catch (err) {
			console.warn(`[bin-processor] Failed to parse ${name}: ${err.message} — skipping`)
		}
	}

	console.log(`[bin-processor] Total: ${allFrames.length} frames from ${batchBuffers.length} file(s)`)
	return allFrames
}

/** Try gunzip; return original buffer if not gzipped. */
function decompressBuffer(buffer) {
	try {
		return gunzipSync(buffer)
	} catch {
		return buffer
	}
}

// ─── End-marker handling ─────────────────────────────────────────────────────

/**
 * Frontend (FlutterCanvasManager.buildEndMarker) emits a single FrameData with
 * data.byteLength === 0, w=0, h=0, t=endTime as a session-close sentinel.
 * The page-unload path can fire more than once (visibilitychange + pagehide,
 * or double pagehide on bfcache restore), so we may receive multiple markers.
 *
 * Returns the real frames (markers stripped) and the latest marker timestamp,
 * which represents the most accurate session-end time. Null if no markers.
 */
function extractEndMarker(frames) {
	const realFrames = []
	let endMarkerTime = null
	let markerCount = 0

	for (const f of frames) {
		if (f.data.length === 0) {
			markerCount++
			if (endMarkerTime === null || f.time > endMarkerTime) {
				endMarkerTime = f.time
			}
		} else {
			realFrames.push(f)
		}
	}

	if (markerCount > 0) {
		console.log(`[bin-processor] Found ${markerCount} end-marker(s); using t=${endMarkerTime} as session end`)
	}

	return { allFrames: realFrames, endMarkerTime }
}

/**
 * Hold the last real frame until the session-end timestamp from the marker.
 * The marker is optional — older sessions and crashed/force-quit sessions
 * may not produce one. If the last real frame's timestamp is past the marker
 * (late frame after marker was queued), the frame wins and we fall back.
 */
function computeLastFrameHoldMs(allFrames, endMarkerTime) {
	if (endMarkerTime !== null) {
		const lastFrameTime = allFrames[allFrames.length - 1].time
		const holdMs = endMarkerTime - lastFrameTime
		if (holdMs > 0) return holdMs
		console.warn(`[bin-processor] End-marker (${endMarkerTime}) not after last frame (${lastFrameTime}) — using fallback`)
	}
	return FALLBACK_LAST_FRAME_HOLD_MS
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

	return { maxW, maxH }
}

// ─── Timeline (mirrors bin-processor.ts buildEffectiveTimeline) ──────────────

function buildEffectiveTimeline(allFrames) {
	const effectiveTimes = [0]
	for (let i = 1; i < allFrames.length; i++) {
		effectiveTimes.push(allFrames[i].time - allFrames[0].time)
	}
	return effectiveTimes
}

// ─── Frame writing (mirrors bin-processor.ts writeFrames) ────────────────────

async function writeFrames(allFrames, workDir) {
	for (let i = 0; i < allFrames.length; i++) {
		const framePath = join(workDir, `src-${String(i).padStart(5, '0')}.webp`)

		if (allFrames[i].data.length === 0) {
			console.warn(`[bin-processor] Skipping frame ${i}: empty buffer`)
			continue
		}

		writeFileSync(framePath, allFrames[i].data)

		// Release frame buffer after writing — reduces memory for long sessions
		allFrames[i].data = Buffer.alloc(0)
	}
}

// ─── Concat file (mirrors bin-processor.ts buildConcatFile) ──────────────────

function buildConcatFile(frameCount, workDir, effectiveTimes, lastFrameHoldMs) {
	const lines = ['ffconcat version 1.0']

	for (let i = 0; i < frameCount; i++) {
		const durationSec = i + 1 < frameCount ? (effectiveTimes[i + 1] - effectiveTimes[i]) / 1000 : lastFrameHoldMs / 1000

		lines.push(`file ${join(workDir, `src-${String(i).padStart(5, '0')}.webp`)}`)
		lines.push(`duration ${durationSec.toFixed(6)}`)
	}

	// FFmpeg concat demuxer requires the last file repeated without duration
	lines.push(`file ${join(workDir, `src-${String(frameCount - 1).padStart(5, '0')}.webp`)}`)

	return lines.join('\n')
}

// ─── FFmpeg (mirrors bin-processor.ts runFfmpeg) ─────────────────────────────

function runFfmpeg(concatPath, outputVideo, maxW, maxH) {
	return new Promise((resolve, reject) => {
		const args = [
		  '-y',
        '-fflags',
        '+genpts',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatPath,
        '-c:v',
        'libx264',
        '-vf',
        `pad=${maxW}:${maxH}:0:0:color=0xC1C3C5,format=yuv420p`,
        '-vsync',
        'vfr',
        '-crf',
        '32',
        '-preset',
        'ultrafast',
        '-tune',
        'stillimage',
        '-threads',
        '0',
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
