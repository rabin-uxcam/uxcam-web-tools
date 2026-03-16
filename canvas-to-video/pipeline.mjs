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
 * Parse all batch buffers into a flat sorted array of frames.
 * @param {{ name: string, buffer: Buffer }[]} batchBuffers
 * @returns {{ allFrames: Object[], totalBatches: number, batchDetails: Object[] }}
 */
export function extractFrames(batchBuffers) {
	const allFrames = []
	const batchDetails = []
	let totalBatches = 0

	for (const { name, buffer } of batchBuffers) {
		const raw = decompressBuffer(buffer)
		const batch = parseBatch(raw)
		totalBatches++

		console.log(
			`  Batch ${String(batch.batchIndex).padStart(4, '0')}: ${batch.frames.length} frames` +
			` (${(raw.byteLength / 1024).toFixed(1)} KB raw)`
		)

		batchDetails.push(buildBatchInfo(name, batch, raw, buffer))

		for (const frame of batch.frames) {
			allFrames.push({
				batchIndex: batch.batchIndex,
				time: frame.time,
				width: frame.width,
				height: frame.height,
				data: frame.data,
			})
		}
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

// ─── Time computation helpers ───────────────────────────────────────────────

export function computeTimeSpan(allFrames) {
	return allFrames.at(-1).time - allFrames[0].time
}

export function computeEffectiveTimeSpan(allFrames, maxGapMs = 10_000) {
	let effective = 0
	for (let i = 0; i < allFrames.length - 1; i++) {
		const gap = allFrames[i + 1].time - allFrames[i].time
		effective += Math.min(gap, maxGapMs)
	}
	return effective + 500 // hold last frame 500ms
}

export function buildEffectiveTimeline(allFrames, maxGapMs = 10_000) {
	const times = [0]
	for (let i = 1; i < allFrames.length; i++) {
		const gap = allFrames[i].time - allFrames[i - 1].time
		times.push(times[i - 1] + Math.min(gap, maxGapMs))
	}
	return times
}
