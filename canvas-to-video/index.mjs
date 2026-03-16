#!/usr/bin/env node

/**
 * Canvas Batch → Video Converter
 *
 * Reads gzipped canvas batch .bin files from a MinIO/S3 bucket,
 * extracts individual frames (WebP/PNG), and assembles them into
 * an MP4 video using ffmpeg.
 *
 * Batch file format:
 *   V2: Binary [4-byte gzipped JSON len][gzipped JSON metadata][raw WebP blobs] (.bin)
 *       JSON: [{ t, sz, w, h }, ...] per frame
 *   V1: Binary [4-byte meta len][raw JSON][offset-based blobs] (.bin)
 *   JSON: Array of change objects with inline base64 data URLs (.json.gz)
 *
 * Usage:
 *   node index.mjs                           # interactive — uses defaults
 *   node index.mjs --bucket uxcam-sessions --prefix sessions/canvas/
 *   node index.mjs --dir ./local-batches     # read from local directory instead of S3
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { execSync } from 'node:child_process'
import { ListObjectsV2Command, GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { parseBatch } from './parse-batch.mjs'

// ─── Config (CLI defaults) ───────────────────────────────────────────────────

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'http://localhost:9000'
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'minioadmin'
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || 'minioadmin'
const BUCKET = getArg('--bucket') || process.env.CANVAS_BUCKET || 'uxcam-sessions'
const PREFIX = getArg('--prefix') || process.env.CANVAS_PREFIX || 'sessions/canvas/'
const LOCAL_DIR = getArg('--dir') || null
const OUTPUT_DIR = getArg('--output') || './output'
const FPS_OVERRIDE = getArg('--fps') ? parseInt(getArg('--fps'), 10) : null

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getArg(flag) {
	const idx = process.argv.indexOf(flag)
	return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null
}

function ensureDir(dir, clean = false) {
	if (clean && existsSync(dir)) {
		rmSync(dir, { recursive: true })
	}
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}


// ─── S3 / MinIO fetching ─────────────────────────────────────────────────────

export function createS3Client(opts = {}) {
	return new S3Client({
		endpoint: opts.endpoint || MINIO_ENDPOINT,
		region: 'us-east-1',
		forcePathStyle: true,
		credentials: {
			accessKeyId: opts.accessKey || MINIO_ACCESS_KEY,
			secretAccessKey: opts.secretKey || MINIO_SECRET_KEY,
		},
	})
}

export async function listCanvasSessions(s3, opts = {}) {
	const cmd = new ListObjectsV2Command({
		Bucket: opts.bucket || BUCKET,
		Prefix: opts.prefix || PREFIX,
		Delimiter: '/',
	})
	const resp = await s3.send(cmd)
	const prefixes = (resp.CommonPrefixes || []).map((p) => p.Prefix)
	return prefixes
}

export async function listBatchFiles(s3, sessionPrefix, opts = {}) {
	const cmd = new ListObjectsV2Command({
		Bucket: opts.bucket || BUCKET,
		Prefix: sessionPrefix,
	})
	const resp = await s3.send(cmd)
	return (resp.Contents || [])
		.filter((obj) => obj.Key.endsWith('.bin') || obj.Key.endsWith('.json.gz'))
		.sort((a, b) => a.Key.localeCompare(b.Key))
}

export async function downloadObject(s3, key, opts = {}) {
	const cmd = new GetObjectCommand({ Bucket: opts.bucket || BUCKET, Key: key })
	const resp = await s3.send(cmd)
	const chunks = []
	for await (const chunk of resp.Body) {
		chunks.push(chunk)
	}
	return Buffer.concat(chunks)
}

// ─── Local directory fetching ────────────────────────────────────────────────

function listLocalBatchFiles(dir) {
	return readdirSync(dir)
		.filter((f) => f.endsWith('.bin') || f.endsWith('.json.gz'))
		.sort()
		.map((f) => join(dir, f))
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function processSession(batchBuffers, sessionName, opts = {}) {
	const outputDir = opts.outputDir || OUTPUT_DIR
	const framesDir = join(outputDir, sessionName, 'frames')
	ensureDir(framesDir, true)

	let allFrames = []
	let totalBatches = 0

	for (const { name, buffer } of batchBuffers) {
		let raw
		try {
			raw = gunzipSync(buffer)
		} catch {
			// maybe not gzipped — try raw
			raw = buffer
		}

		const batch = parseBatch(raw)
		totalBatches++
		console.log(
			`  Batch ${String(batch.batchIndex).padStart(4, '0')}: ${batch.frames.length} frames` +
			` (${(raw.byteLength / 1024).toFixed(1)} KB raw)`
		)

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

	if (allFrames.length === 0) {
		console.log('  No frames found — skipping')
		return
	}

	// Sort frames by time
	allFrames.sort((a, b) => a.time - b.time)

	const timeSpanMs = allFrames[allFrames.length - 1].time - allFrames[0].time
	const TARGET_FPS = opts.fps || FPS_OVERRIDE || 3

	const sharp = (await import('sharp')).default

	// Resolve dimensions from image data if not available (new JSON format)
	const needsDimensions = allFrames.some((f) => !f.width || !f.height)
	if (needsDimensions) {
		const firstMeta = await sharp(Buffer.from(allFrames[0].data)).metadata()
		const inferredW = firstMeta.width
		const inferredH = firstMeta.height
		for (const f of allFrames) {
			if (!f.width) f.width = inferredW
			if (!f.height) f.height = inferredH
		}
	}

	// Determine the video canvas size
	let maxW = 0, maxH = 0
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

	const frameDurationMs = 1000 / TARGET_FPS
	const startTime = allFrames[0].time
	const totalVideoFrames = Math.ceil(timeSpanMs / frameDurationMs) + 1

	console.log(`  Total: ${allFrames.length} source frames from ${totalBatches} batches`)
	console.log(`  Video canvas size: ${maxW}x${maxH}${hasVaryingSizes ? ' (frames have varying sizes)' : ''}`)
	console.log(`  Time span: ${(timeSpanMs / 1000).toFixed(1)}s`)
	console.log(`  Output: ${totalVideoFrames} video frames at ${TARGET_FPS}fps`)

	// Always use WebP — passthrough when same size, resize+pad when varying.
	const { copyFileSync } = await import('node:fs')
	const frameExt = 'webp'

	const sourceFramePaths = []
	for (let i = 0; i < allFrames.length; i++) {
		const frame = allFrames[i]
		const framePath = join(framesDir, `src-${String(i).padStart(5, '0')}.${frameExt}`)
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
		sourceFramePaths.push(framePath)
	}

	// Map each video frame index to the correct source frame using timestamps
	let sourceIdx = 0
	let videoFrameCount = 0
	for (let vi = 0; vi < totalVideoFrames; vi++) {
		const videoTimeMs = startTime + vi * frameDurationMs
		// Advance source index to the latest frame at or before this video time
		while (sourceIdx + 1 < allFrames.length && allFrames[sourceIdx + 1].time <= videoTimeMs) {
			sourceIdx++
		}
		const outPath = join(framesDir, `frame-${String(vi).padStart(5, '0')}.${frameExt}`)
		copyFileSync(sourceFramePaths[sourceIdx], outPath)
		videoFrameCount++
	}

	console.log(`  Wrote ${videoFrameCount} video frames (from ${allFrames.length} source frames) to ${framesDir}`)

	const inputPattern = join(framesDir, `frame-%05d.${frameExt}`)

	// Assemble video with ffmpeg
	const outputVideo = join(outputDir, sessionName, `${sessionName}.mp4`)
	const ffmpegCmd = [
		'ffmpeg', '-y',
		'-framerate', String(TARGET_FPS),
		'-i', inputPattern,
		'-c:v', 'libx264',
		'-pix_fmt', 'yuv420p',
		'-crf', '28',
		'-preset', 'fast',
		outputVideo,
	].join(' ')

	console.log(`  Running: ${ffmpegCmd}`)
	try {
		execSync(ffmpegCmd, { stdio: 'pipe' })
		const { statSync } = await import('node:fs')
		const videoSizeBytes = statSync(outputVideo).size
		console.log(`  Video saved: ${outputVideo} (${(videoSizeBytes / 1024 / 1024).toFixed(2)} MB)`)
		return { videoPath: outputVideo, framesDir, frameCount: allFrames.length, videoFrameCount, videoSizeBytes }
	} catch (err) {
		console.error(`  ffmpeg failed:`, err.stderr?.toString() || err.message)
		console.log(`  Frames are still available in ${framesDir}`)
		console.log(`  You can manually run: ffmpeg -framerate ${TARGET_FPS} -i "${inputPattern}" -c:v libx264 -pix_fmt yuv420p "${outputVideo}"`)
		return null
	}
}

// ─── VFR Mode (Variable Frame Rate) ──────────────────────────────────────────
//
// For activity-based capture where frames have irregular timestamps.
// Uses a CFR image sequence at 30fps with timestamp-based frame placement.
// Duplicate frames between changes compress to near-zero via H.264 P-frames,
// producing small files while preserving accurate timing (~33ms granularity).

export async function processSessionVFR(batchBuffers, sessionName, opts = {}) {
	const outputDir = opts.outputDir || OUTPUT_DIR
	const framesDir = join(outputDir, sessionName, 'frames-vfr')
	ensureDir(framesDir, true)

	let allFrames = []
	let totalBatches = 0
	const batchDetails = [] // detailed info per bin file

	for (const { name, buffer } of batchBuffers) {
		let raw
		try {
			raw = gunzipSync(buffer)
		} catch {
			raw = buffer
		}

		const batch = parseBatch(raw)
		totalBatches++
		console.log(
			`  Batch ${String(batch.batchIndex).padStart(4, '0')}: ${batch.frames.length} frames` +
			` (${(raw.byteLength / 1024).toFixed(1)} KB raw)`
		)

		const batchInfo = {
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
			batchInfo.timeRange = {
				start: batch.frames[0].time,
				end: batch.frames[batch.frames.length - 1].time,
				spanMs: batch.frames[batch.frames.length - 1].time - batch.frames[0].time,
			}
		}
		batchDetails.push(batchInfo)

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

	if (allFrames.length === 0) {
		console.log('  No frames found — skipping')
		return
	}

	// Sort frames by time
	allFrames.sort((a, b) => a.time - b.time)

	const timeSpanMs = allFrames[allFrames.length - 1].time - allFrames[0].time

	const sharp = (await import('sharp')).default

	// Resolve dimensions from image data if not available (new JSON format)
	const needsDimensions = allFrames.some((f) => !f.width || !f.height)
	if (needsDimensions) {
		const firstMeta = await sharp(Buffer.from(allFrames[0].data)).metadata()
		const inferredW = firstMeta.width
		const inferredH = firstMeta.height
		for (const f of allFrames) {
			if (!f.width) f.width = inferredW
			if (!f.height) f.height = inferredH
		}
	}

	// Determine video canvas size
	let maxW = 0, maxH = 0
	const hasVaryingSizes = allFrames.some(
		(f) => f.width !== allFrames[0].width || f.height !== allFrames[0].height
	)
	for (const f of allFrames) {
		if (f.width > maxW) maxW = f.width
		if (f.height > maxH) maxH = f.height
	}
	if (maxW % 2 !== 0) maxW++
	if (maxH % 2 !== 0) maxH++

	// Use 10fps CFR — source frames arrive at ~5fps max (200ms apart), so 10fps
	// (100ms granularity) is enough for accurate placement with minimal duplicates.
	// Higher output FPS just adds unnecessary duplicate frames for no timing benefit.
	// Clamp idle gaps to 10s to avoid excessively long videos.
	const TARGET_FPS = opts.fps || FPS_OVERRIDE || 5
	const frameDurationMs = 1000 / TARGET_FPS

	// Compute effective time span with idle gaps clamped to 10s
	let effectiveTimeSpanMs = 0
	for (let i = 0; i < allFrames.length - 1; i++) {
		const gap = allFrames[i + 1].time - allFrames[i].time
		effectiveTimeSpanMs += Math.min(gap, 10000)
	}
	effectiveTimeSpanMs += 500 // last frame hold

	const totalVideoFrames = Math.ceil(effectiveTimeSpanMs / frameDurationMs) + 1

	console.log(`  Total: ${allFrames.length} source frames from ${totalBatches} batches`)
	console.log(`  Video canvas size: ${maxW}x${maxH}${hasVaryingSizes ? ' (frames have varying sizes)' : ''}`)
	console.log(`  Time span: ${(timeSpanMs / 1000).toFixed(1)}s (effective: ${(effectiveTimeSpanMs / 1000).toFixed(1)}s with idle clamping)`)
	console.log(`  Mode: VFR (timestamp-based CFR at ${TARGET_FPS}fps for optimal compression)`)
	console.log(`  Output: ${totalVideoFrames} video frames at ${TARGET_FPS}fps`)

	// Always use WebP
	const { copyFileSync } = await import('node:fs')
	const frameExt = 'webp'

	// Write source frames to disk
	const sourceFramePaths = []
	for (let i = 0; i < allFrames.length; i++) {
		const frame = allFrames[i]
		const framePath = join(framesDir, `src-${String(i).padStart(5, '0')}.${frameExt}`)
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
		sourceFramePaths.push(framePath)
	}

	// Build a mapping from video time → source frame, with idle gap clamping.
	// We walk through source frames and track the "effective" elapsed time
	// (clamping any gap > 10s down to 10s), then for each video frame index
	// we pick the correct source frame.
	const sourceEffectiveTimes = [0] // effective time offset for each source frame
	for (let i = 1; i < allFrames.length; i++) {
		const gap = allFrames[i].time - allFrames[i - 1].time
		sourceEffectiveTimes.push(sourceEffectiveTimes[i - 1] + Math.min(gap, 10000))
	}

	let sourceIdx = 0
	let videoFrameCount = 0
	for (let vi = 0; vi < totalVideoFrames; vi++) {
		const videoTimeMs = vi * frameDurationMs
		// Advance source index to the latest frame at or before this video time
		while (sourceIdx + 1 < allFrames.length && sourceEffectiveTimes[sourceIdx + 1] <= videoTimeMs) {
			sourceIdx++
		}
		const outPath = join(framesDir, `frame-${String(vi).padStart(5, '0')}.${frameExt}`)
		copyFileSync(sourceFramePaths[sourceIdx], outPath)
		videoFrameCount++
	}

	// Write manifest with detailed bin data and frame info
	const manifest = {
		session: sessionName,
		totalBatches,
		totalFrames: allFrames.length,
		timeSpanMs,
		effectiveTimeSpanMs,
		videoFps: TARGET_FPS,
		videoFrameCount,
		videoSize: { width: maxW, height: maxH },
		batches: batchDetails,
		frames: allFrames.map((f, i) => {
			let durationMs
			if (i + 1 < allFrames.length) {
				durationMs = allFrames[i + 1].time - f.time
				if (durationMs > 10000) durationMs = 10000
			} else {
				durationMs = 500
			}
			return {
				index: i,
				batchIndex: f.batchIndex,
				time: f.time,
				effectiveTime: sourceEffectiveTimes[i],
				width: f.width,
				height: f.height,
				durationMs,
				file: `src-${String(i).padStart(5, '0')}.${frameExt}`,
			}
		}),
	}
	const manifestPath = join(outputDir, sessionName, 'manifest.json')
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

	console.log(`  Wrote ${videoFrameCount} video frames (from ${allFrames.length} source frames) + manifest.json`)

	// Assemble video with ffmpeg using image sequence (CFR — optimal H.264 compression)
	const inputPattern = join(framesDir, `frame-%05d.${frameExt}`)
	const outputVideo = join(outputDir, sessionName, `${sessionName}.mp4`)
	const ffmpegCmd = [
		'ffmpeg', '-y',
		'-framerate', String(TARGET_FPS),
		'-i', inputPattern,
		'-c:v', 'libx264',
		'-pix_fmt', 'yuv420p',
		'-crf', '28',
		'-preset', 'fast',
		outputVideo,
	].join(' ')

	console.log(`  Running: ${ffmpegCmd}`)
	try {
		execSync(ffmpegCmd, { stdio: 'pipe' })
		const { statSync } = await import('node:fs')
		const videoSizeBytes = statSync(outputVideo).size
		console.log(`  Video saved: ${outputVideo} (${(videoSizeBytes / 1024 / 1024).toFixed(2)} MB)`)
		return { videoPath: outputVideo, framesDir, manifestPath, frameCount: allFrames.length, videoFrameCount, videoSizeBytes, manifest }
	} catch (err) {
		console.error(`  ffmpeg failed:`, err.stderr?.toString() || err.message)
		console.log(`  Frames are still available in ${framesDir}`)
		console.log(`  You can manually run: ffmpeg -framerate ${TARGET_FPS} -i "${inputPattern}" -c:v libx264 -pix_fmt yuv420p "${outputVideo}"`)
		return null
	}
}

async function main() {
	console.log('Canvas Batch → Video Converter')
	console.log('================================')

	ensureDir(OUTPUT_DIR)

	// Check ffmpeg
	try {
		execSync('ffmpeg -version', { stdio: 'pipe' })
	} catch {
		console.error('Error: ffmpeg is not installed. Install it with: brew install ffmpeg')
		process.exit(1)
	}

	if (LOCAL_DIR) {
		// ─── Local mode ──────────────────────────────────────────────────
		console.log(`\nReading from local directory: ${LOCAL_DIR}`)
		const files = listLocalBatchFiles(LOCAL_DIR)
		if (files.length === 0) {
			console.log('No .bin files found')
			process.exit(1)
		}
		console.log(`Found ${files.length} batch file(s)\n`)

		const batchBuffers = files.map((f) => ({
			name: basename(f),
			buffer: readFileSync(f),
		}))

		const sessionName = basename(LOCAL_DIR) || 'local-session'
		await processSession(batchBuffers, sessionName)
	} else {
		// ─── S3/MinIO mode ───────────────────────────────────────────────
		console.log(`\nConnecting to MinIO: ${MINIO_ENDPOINT}`)
		console.log(`Bucket: ${BUCKET}, Prefix: ${PREFIX}\n`)

		const s3 = createS3Client()

		let sessions
		try {
			sessions = await listCanvasSessions(s3)
		} catch (err) {
			console.error('Failed to connect to MinIO:', err.message)
			console.log('\nMake sure MinIO is running and accessible at', MINIO_ENDPOINT)
			process.exit(1)
		}

		if (sessions.length === 0) {
			console.log('No canvas sessions found in bucket')
			process.exit(0)
		}

		console.log(`Found ${sessions.length} canvas session(s):\n`)

		for (const sessionPrefix of sessions) {
			const sessionName = sessionPrefix.replace(PREFIX, '').replace(/\/$/, '')
			console.log(`Processing session: ${sessionName}`)

			const objects = await listBatchFiles(s3, sessionPrefix)
			if (objects.length === 0) {
				console.log('  No batch files found — skipping')
				continue
			}

			console.log(`  Downloading ${objects.length} batch file(s)...`)

			const batchBuffers = []
			for (const obj of objects) {
				const buffer = await downloadObject(s3, obj.Key)
				batchBuffers.push({ name: basename(obj.Key), buffer })
			}

			await processSession(batchBuffers, sessionName)
			console.log()
		}
	}

	console.log('\nDone!')
}

// Only run CLI when executed directly (not when imported by server.mjs)
import { fileURLToPath as _fup } from 'node:url'
import { resolve as _resolve } from 'node:path'
if (process.argv[1] && _resolve(process.argv[1]) === _fup(import.meta.url)) {
	main().catch((err) => {
		console.error('Fatal error:', err)
		process.exit(1)
	})
}
