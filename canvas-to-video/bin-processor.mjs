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

const LAST_FRAME_HOLD_MS = 500
const FRAME_QUALITY = 80

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
	const allFrames = parseBatchBuffers(batchBuffers)
	if (allFrames.length === 0) {
		console.log('[bin-processor] No frames found in batch buffers, returning')
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
		const concatPath = join(workDir, 'concat.txt')
		writeFileSync(concatPath, buildConcatFile(allFrames.length, workDir, effectiveTimes), 'utf-8')

		// g) FFmpeg encode
		const outputVideo = join(outputDir, `${sessionId}-bin`, `${sessionId}.mp4`)
		console.log('[bin-processor] Starting FFmpeg encode')
		await runFfmpeg(concatPath, outputVideo)
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
 * Delegates to parseBatch (parse-batch.mjs) which handles all wire formats:
 *   - V3 (current): gzip(JSON array with inline base64 data URLs)
 *   - V2: [4-byte gzipped JSON len][gzipped JSON][raw WebP blobs]
 *   - V1 (legacy): [4-byte raw JSON len][raw JSON]{frames:[...offset/size...]}[blobs]
 *   - Legacy JSON: array of change objects with inline base64 data URLs
 *
 * S3-stored .bin files may also be gzipped at the outer level.
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

	// Cache filler background — same for every padded frame, no need to regenerate
	let cachedFillerBg = null

	for (let i = 0; i < allFrames.length; i++) {
		const framePath = join(workDir, `src-${String(i).padStart(5, '0')}.webp`)

		if (needsResize) {
			const frame = allFrames[i]
			const padBottom = Math.max(0, maxH - frame.height)
			const padRight = Math.max(0, maxW - frame.width)

			if (padBottom > 0 || padRight > 0) {
				if (!cachedFillerBg) {
					cachedFillerBg = await sharp({
						create: { width: maxW, height: maxH, channels: 3, background: { r: 193, g: 195, b: 197 } },
					})
						.webp()
						.toBuffer()
				}

				await sharp(cachedFillerBg)
					.composite([{ input: frame.data, top: 0, left: 0 }])
					.webp({ quality: FRAME_QUALITY })
					.toFile(framePath)
			} else {
				// Frame matches max dimensions but may have odd dimensions — just re-encode
				await sharp(frame.data).webp({ quality: FRAME_QUALITY }).toFile(framePath)
			}
		} else {
			writeFileSync(framePath, allFrames[i].data)
		}

		// Release frame buffer after writing — reduces memory for long sessions
		allFrames[i].data = Buffer.alloc(0)
	}
}

// ─── Concat file (mirrors bin-processor.ts buildConcatFile) ──────────────────

function buildConcatFile(frameCount, workDir, effectiveTimes) {
	const lines = ['ffconcat version 1.0']

	for (let i = 0; i < frameCount; i++) {
		const durationSec = i + 1 < frameCount ? (effectiveTimes[i + 1] - effectiveTimes[i]) / 1000 : LAST_FRAME_HOLD_MS / 1000

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
			'-fflags',
			'+genpts',
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
			'fast',
			'-tag:v',
			'hvc1',
			'-x265-params',
			'keyint=60:min-keyint=30',
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
