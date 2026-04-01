/**
 * Shared pipeline helpers for canvas-to-video conversion strategies.
 *
 * Provides the common building blocks that every strategy uses:
 * batch parsing, dimension resolution, frame writing, and ffmpeg execution.
 */

import { writeFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { execSync } from 'node:child_process'
import { parseBatch } from './parse-batch.mjs'

// ─── Directory helpers ──────────────────────────────────────────────────────

export function ensureDir(dir, clean = false) {
	if (clean && existsSync(dir)) rmSync(dir, { recursive: true })
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ─── Batch parsing ──────────────────────────────────────────────────────────

/**
 * Parse batch index from filename like "batch-0001.bin".
 * Returns the parsed integer or -1 if the name doesn't match.
 */
function parseBatchIndexFromName(name) {
	const m = name.match(/batch-(\d+)\.bin$/i)
	return m ? parseInt(m[1], 10) : -1
}

/**
 * Parse all batch buffers into a flat sorted array of frames.
 * @param {{ name: string, buffer: Buffer }[]} batchBuffers
 * @returns {{ allFrames: Object[], totalBatches: number, batchDetails: Object[] }}
 */
export function extractFrames(batchBuffers) {
	const allFrames = []
	const batchDetails = []
	let totalBatches = 0

	let parseFailures = 0
	for (const { name, buffer } of batchBuffers) {
		try {
			const raw = decompressBuffer(buffer)
			const batch = parseBatch(raw)
			totalBatches++

			// Prefer batch index from filename (V3/JSON formats always return 0)
			const fileIndex = parseBatchIndexFromName(name)
			const batchIndex = fileIndex >= 0 ? fileIndex : batch.batchIndex

			console.log(
				`  Batch ${String(batchIndex).padStart(4, '0')}: ${batch.frames.length} frames` +
				` (${(raw.byteLength / 1024).toFixed(1)} KB raw)`
			)

			batchDetails.push(buildBatchInfo(name, { ...batch, batchIndex }, raw, buffer))

			for (const frame of batch.frames) {
				allFrames.push({
					batchIndex,
					time: frame.time,
					width: frame.width,
					height: frame.height,
					data: frame.data,
				})
			}
		} catch (err) {
			parseFailures++
			console.warn(`  ⚠ Failed to parse batch "${name}": ${err.message} — skipping`)
		}
	}
	if (parseFailures > 0) {
		console.warn(`  ⚠ ${parseFailures}/${batchBuffers.length} batch(es) failed to parse`)
	}

	allFrames.sort((a, b) => a.time - b.time)
	return { allFrames, totalBatches, batchDetails }
}

function decompressBuffer(buffer) {
	try {
		return gunzipSync(buffer)
	} catch {
		return buffer
	}
}

function buildBatchInfo(name, batch, raw, buffer) {
	const info = {
		file: name,
		batchIndex: batch.batchIndex,
		rawSizeBytes: raw.byteLength,
		compressedSizeBytes: buffer.byteLength,
		frameCount: batch.frames.length,
		frames: batch.frames.map((f) => ({
			time: f.time,
			width: f.width,
			height: f.height,
			sizeBytes: f.data.byteLength,
		})),
	}
	if (batch.frames.length > 0) {
		info.timeRange = {
			start: batch.frames[0].time,
			end: batch.frames.at(-1).time,
			spanMs: batch.frames.at(-1).time - batch.frames[0].time,
		}
	}
	return info
}

// ─── Dimension resolution ───────────────────────────────────────────────────

/**
 * Resolve missing dimensions from image metadata, determine canvas size.
 * Mutates frames in-place to fill in missing width/height.
 * @returns {{ maxW: number, maxH: number, hasVaryingSizes: boolean }}
 */
export async function resolveCanvasSize(allFrames) {
	const sharp = (await import('sharp')).default

	const needsDimensions = allFrames.some((f) => !f.width || !f.height)
	if (needsDimensions) {
		const firstMeta = await sharp(Buffer.from(allFrames[0].data)).metadata()
		for (const f of allFrames) {
			if (!f.width) f.width = firstMeta.width
			if (!f.height) f.height = firstMeta.height
		}
	}

	let maxW = 0
	let maxH = 0
	const hasVaryingSizes = allFrames.some(
		(f) => f.width !== allFrames[0].width || f.height !== allFrames[0].height
	)
	for (const f of allFrames) {
		if (f.width > maxW) maxW = f.width
		if (f.height > maxH) maxH = f.height
	}
	// libx264 requires even dimensions
	if (maxW % 2 !== 0) maxW++
	if (maxH % 2 !== 0) maxH++

	return { maxW, maxH, hasVaryingSizes }
}

// ─── Source frame writing ───────────────────────────────────────────────────

/**
 * Write source frames to disk as WebP files, resizing if sizes vary.
 * @returns {string[]} Array of absolute file paths for each source frame
 */
export async function writeSourceFrames(allFrames, framesDir, maxW, maxH, hasVaryingSizes) {
	const sharp = (await import('sharp')).default
	const paths = []

	for (let i = 0; i < allFrames.length; i++) {
		const frame = allFrames[i]
		const framePath = join(framesDir, `src-${String(i).padStart(5, '0')}.webp`)

		if (hasVaryingSizes) {
			await sharp(Buffer.from(frame.data))
				.resize(maxW, maxH, {
					fit: 'contain',
					background: { r: 0, g: 0, b: 0, alpha: 1 },
				})
				.webp({ quality: 80 })
				.toFile(framePath)
		} else {
			writeFileSync(framePath, Buffer.from(frame.data))
		}
		paths.push(framePath)
	}

	return paths
}

// ─── FFmpeg execution ───────────────────────────────────────────────────────

/**
 * Run an ffmpeg command and return the video file size, or null on failure.
 * @param {string[]} args - FFmpeg arguments (without 'ffmpeg' prefix)
 * @param {string} outputVideo - Path to the expected output file
 * @returns {{ videoSizeBytes: number } | null}
 */
export function runFfmpeg(args, outputVideo) {
	const cmd = ['ffmpeg', ...args].join(' ')
	console.log(`  Running: ${cmd}`)

	try {
		execSync(cmd, { stdio: 'pipe' })
		const videoSizeBytes = statSync(outputVideo).size
		console.log(`  Video saved: ${outputVideo} (${(videoSizeBytes / 1024 / 1024).toFixed(2)} MB)`)
		return { videoSizeBytes }
	} catch (err) {
		console.error(`  ffmpeg failed:`, err.stderr?.toString() || err.message)
		return null
	}
}

// ─── Missing batch detection ────────────────────────────────────────────────

/**
 * Detect gaps in the batch file sequence and return frame-pair indices where
 * a missing batch causes the gap. At those boundaries the real elapsed time
 * is preserved (freeze last frame) instead of being clamped to maxGapMs.
 *
 * @param {{ name: string }[]} batchBuffers
 * @param {Object[]} allFrames - sorted frames (each has batchIndex)
 * @returns {Set<number>} frame indices i where frames[i]→frames[i+1] spans a missing batch
 */
export function detectBatchGaps(batchBuffers, allFrames) {
	const batchPattern = /batch-(\d+)\.bin$/i
	const presentIndices = []
	for (const { name } of batchBuffers) {
		const m = name.match(batchPattern)
		if (m) presentIndices.push(parseInt(m[1], 10))
	}

	if (presentIndices.length < 2) return new Set()

	presentIndices.sort((a, b) => a - b)

	// Find which batch indices are missing in the sequence
	const missingIndices = new Set()
	for (let i = 0; i < presentIndices.length - 1; i++) {
		for (let idx = presentIndices[i] + 1; idx < presentIndices[i + 1]; idx++) {
			missingIndices.add(idx)
		}
	}

	if (missingIndices.size === 0) return new Set()

	// For each pair of consecutive present batches with a gap, mark the
	// frame boundary where the transition happens in the sorted frame list
	const gapFrameIndices = new Set()
	for (let i = 0; i < presentIndices.length - 1; i++) {
		const cur = presentIndices[i]
		const next = presentIndices[i + 1]
		if (next - cur <= 1) continue

		for (let fi = 0; fi < allFrames.length - 1; fi++) {
			if (allFrames[fi].batchIndex === cur && allFrames[fi + 1].batchIndex === next) {
				gapFrameIndices.add(fi)
			}
		}
	}

	if (gapFrameIndices.size > 0) {
		console.log(`  ⚠ Detected ${missingIndices.size} missing batch(es): [${[...missingIndices].join(', ')}]`)
		console.log(`    Preserving real duration at ${gapFrameIndices.size} gap boundary(ies) (freeze-frame)`)
	}

	return gapFrameIndices
}

// ─── Time computation helpers ───────────────────────────────────────────────

export function computeTimeSpan(allFrames) {
	return allFrames.at(-1).time - allFrames[0].time
}

export function computeEffectiveTimeSpan(allFrames) {
	return computeTimeSpan(allFrames) + 500 // hold last frame 500ms
}

export function buildEffectiveTimeline(allFrames) {
	const times = [0]
	for (let i = 1; i < allFrames.length; i++) {
		times.push(allFrames[i].time - allFrames[0].time)
	}
	return times
}
