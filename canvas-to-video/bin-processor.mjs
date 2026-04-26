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
 * @returns {{ videoPath, frameCount, totalBatches, videoSizeBytes, dimensions }}
 */
export async function processBin(batchBuffers, sessionId, outputDir) {
	// a) Parse batch buffers → frames
	const allParsed = parseBatchBuffers(batchBuffers)
	if (allParsed.length === 0) {
		console.log('[bin-processor] No frames found in batch buffers, returning')
		return null
	}

	// Separate end-marker frames (sz=0, w=0, h=0) from real video frames.
	// End markers carry the session-close timestamp for accurate duration.
	const allFrames = []
	let endMarkerTime = null
	for (const f of allParsed) {
		if (f.data.length === 0 && f.width === 0 && f.height === 0) {
			endMarkerTime = f.time
			console.log(`[bin-processor] Found session end marker at t=${endMarkerTime}`)
		} else {
			allFrames.push(f)
		}
	}

	if (allFrames.length === 0) {
		console.log('[bin-processor] No video frames found (only end markers), returning')
		return null
	}

	// b) Sort frames by timestamp
	allFrames.sort((a, b) => a.time - b.time)

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
		// If end marker exists, extend last frame hold to match true session end.
		let lastFrameHoldMs = LAST_FRAME_HOLD_MS
		if (endMarkerTime !== null) {
			const lastFrameTime = allFrames[allFrames.length - 1].time
			const gap = endMarkerTime - lastFrameTime
			if (gap > 0) lastFrameHoldMs = gap
		}
		const concatPath = join(workDir, 'concat.txt')
		writeFileSync(concatPath, buildConcatFile(allFrames.length, workDir, effectiveTimes, lastFrameHoldMs), 'utf-8')

		// g) FFmpeg encode
		const outputVideo = join(outputDir, `${sessionId}-bin`, `${sessionId}.mp4`)
		console.log('[bin-processor] Starting FFmpeg encode')
		await runFfmpeg(concatPath, outputVideo)
		console.log('[bin-processor] FFmpeg encode complete')

		const videoSizeBytes = statSync(outputVideo).size

		// Compute expected video duration from the concat timeline
		const lastEffective = effectiveTimes[effectiveTimes.length - 1] || 0
		const expectedVideoDurationMs = lastEffective + lastFrameHoldMs

		return {
			videoPath: outputVideo,
			frameCount: allFrames.length,
			videoSizeBytes,
			dimensions: { width: maxW, height: maxH, hasVaryingSizes },
			timing: {
				firstFrameTime: allFrames[0].time,
				lastFrameTime: allFrames[allFrames.length - 1].time,
				endMarkerTime,
				lastFrameHoldMs,
				expectedVideoDurationMs,
			},
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
			// Outer decompression — S3-stored .bin files may be gzipped at the outer level
			const raw = decompressBuffer(buffer)

			const gzippedJsonLen = raw.readUInt32BE(0)
			const gzippedJson = raw.subarray(4, 4 + gzippedJsonLen)
			const jsonBytes = gunzipSync(gzippedJson)
			const meta = JSON.parse(new TextDecoder().decode(jsonBytes))

			const dataStart = 4 + gzippedJsonLen
			let cursor = 0

			for (const f of meta) {
				const frameData = raw.subarray(dataStart + cursor, dataStart + cursor + f.sz)
				cursor += f.sz
				allFrames.push({ time: f.t, width: f.w, height: f.h, data: Buffer.from(frameData) })
			}

			console.log(`[bin-processor] ${name}: ${meta.length} frames extracted`)
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

function buildEffectiveTimeline(allFrames) {
	const effectiveTimes = [0]
	for (let i = 1; i < allFrames.length; i++) {
		effectiveTimes.push(allFrames[i].time - allFrames[0].time)
	}
	return effectiveTimes
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

function buildConcatFile(frameCount, workDir, effectiveTimes, lastFrameHoldMs = LAST_FRAME_HOLD_MS) {
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

function runFfmpeg(concatPath, outputVideo) {
	return new Promise((resolve, reject) => {
		const args = [
			'-y',
			'-f',
			'concat',
			'-safe',
			'0',
			'-i',
			concatPath,
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
