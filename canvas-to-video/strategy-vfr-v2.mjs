/**
 * Variable Frame v2 — optimized VFR using ffmpeg concat demuxer.
 *
 * Instead of duplicating frames via copyFileSync, this strategy writes
 * each source frame once and uses a concat demuxer manifest to tell
 * ffmpeg how long to display each frame. Combined with tuned encoding
 * parameters, this produces significantly smaller output files.
 */

import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { registerStrategy } from './strategy-registry.mjs'
import {
	ensureDir, extractFrames, resolveCanvasSize,
	writeSourceFrames, runFfmpeg,
	computeTimeSpan, computeEffectiveTimeSpan, buildEffectiveTimeline,
	detectBatchGaps,
} from './pipeline.mjs'

const DEFAULT_FPS = 3

async function convert(batchBuffers, sessionName, opts = {}) {
	const outputDir = opts.outputDir || './output'
	const framesDir = join(outputDir, sessionName, 'frames-vfr-v2')
	ensureDir(framesDir, true)

	const { allFrames, totalBatches, batchDetails } = extractFrames(batchBuffers)
	if (allFrames.length === 0) {
		console.log('  No frames found — skipping')
		return null
	}

	const { maxW, maxH, hasVaryingSizes } = await resolveCanvasSize(allFrames)

	const missingBatchGaps = detectBatchGaps(batchBuffers, allFrames)
	const fps = opts.fps || DEFAULT_FPS
	const timeSpanMs = computeTimeSpan(allFrames)
	const effectiveTimeSpanMs = computeEffectiveTimeSpan(allFrames, 10_000, missingBatchGaps)
	const sourceEffectiveTimes = buildEffectiveTimeline(allFrames, 10_000, missingBatchGaps)
	const totalVideoFrames = Math.ceil(effectiveTimeSpanMs / (1000 / fps)) + 1

	console.log(`  Total: ${allFrames.length} source frames from ${totalBatches} batches`)
	console.log(`  Video canvas size: ${maxW}x${maxH}${hasVaryingSizes ? ' (varying)' : ''}`)
	console.log(`  Time span: ${(timeSpanMs / 1000).toFixed(1)}s (effective: ${(effectiveTimeSpanMs / 1000).toFixed(1)}s)`)
	console.log(`  Mode: VFR v2 (concat demuxer, no frame duplication)`)

	// Write each source frame once — no duplication
	const sourceFramePaths = await writeSourceFrames(allFrames, framesDir, maxW, maxH, hasVaryingSizes)

	// Build concat demuxer file with per-frame durations
	const concatPath = join(framesDir, 'concat.txt')
	const concatContent = buildConcatFile(sourceFramePaths, sourceEffectiveTimes)
	writeFileSync(concatPath, concatContent, 'utf-8')

	console.log(`  Wrote ${allFrames.length} source frames + concat.txt (no frame duplication)`)

	// Encode with optimized ffmpeg settings
	const outputVideo = join(outputDir, sessionName, `${sessionName}.mp4`)
	const result = runFfmpeg([
		'-y',
		'-f', 'concat',
		'-safe', '0',
		'-i', concatPath,
		'-c:v', 'libx264',
		'-pix_fmt', 'yuv420p',
		'-r', String(fps),
		'-crf', '30',
		'-preset', 'slow',
		'-tune', 'stillimage',
		'-g', String(fps * 60),
		'-bf', '2',
		'-movflags', '+faststart',
		outputVideo,
	], outputVideo)

	if (!result) return null

	// Write manifest (same format as vfr-v1 for compatibility)
	const manifest = buildManifest(
		sessionName, totalBatches, allFrames, timeSpanMs, effectiveTimeSpanMs,
		fps, totalVideoFrames, maxW, maxH, batchDetails, sourceEffectiveTimes
	)
	const manifestPath = join(outputDir, sessionName, 'manifest-v2.json')
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

	return {
		videoPath: outputVideo,
		framesDir,
		manifestPath,
		frameCount: allFrames.length,
		videoFrameCount: totalVideoFrames,
		videoSizeBytes: result.videoSizeBytes,
		manifest,
	}
}

function buildConcatFile(sourceFramePaths, sourceEffectiveTimes) {
	const lines = ['ffconcat version 1.0']

	for (let i = 0; i < sourceFramePaths.length; i++) {
		const durationSec = (i + 1 < sourceFramePaths.length)
			? (sourceEffectiveTimes[i + 1] - sourceEffectiveTimes[i]) / 1000
			: 0.5 // hold last frame 500ms
		lines.push(`file ${sourceFramePaths[i]}`)
		lines.push(`duration ${durationSec.toFixed(6)}`)
	}

	// ffmpeg concat demuxer requires the last file repeated without duration
	lines.push(`file ${sourceFramePaths.at(-1)}`)
	return lines.join('\n')
}

function buildManifest(sessionName, totalBatches, allFrames, timeSpanMs, effectiveTimeSpanMs, fps, videoFrameCount, maxW, maxH, batchDetails, sourceEffectiveTimes) {
	return {
		session: sessionName,
		strategy: 'vfr-v2',
		totalBatches,
		totalFrames: allFrames.length,
		timeSpanMs,
		effectiveTimeSpanMs,
		videoFps: fps,
		videoFrameCount,
		videoSize: { width: maxW, height: maxH },
		batches: batchDetails,
		frames: allFrames.map((f, i) => {
			const durationMs = (i + 1 < allFrames.length)
				? Math.min(allFrames[i + 1].time - f.time, 10_000)
				: 500
			return {
				index: i,
				batchIndex: f.batchIndex,
				time: f.time,
				effectiveTime: sourceEffectiveTimes[i],
				width: f.width,
				height: f.height,
				durationMs,
				file: `src-${String(i).padStart(5, '0')}.webp`,
			}
		}),
	}
}

registerStrategy({
	id: 'vfr-v2',
	name: 'Variable Frame v2',
	description: 'Concat demuxer (no frame duplication), crf 30, preset slow, tune stillimage.',
	convert,
})
