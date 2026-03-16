/**
 * Variable Frame v1 — extracted from the original processSessionVFR().
 *
 * Clamps idle gaps to 10s, maps frames using effective timestamps,
 * duplicates frames via copyFileSync, and generates a manifest.
 */

import { join } from 'node:path'
import { copyFileSync, writeFileSync } from 'node:fs'
import { registerStrategy } from './strategy-registry.mjs'
import {
	ensureDir, extractFrames, resolveCanvasSize,
	writeSourceFrames, runFfmpeg,
	computeTimeSpan, computeEffectiveTimeSpan, buildEffectiveTimeline,
} from './pipeline.mjs'

const DEFAULT_FPS = 3

async function convert(batchBuffers, sessionName, opts = {}) {
	const outputDir = opts.outputDir || './output'
	const framesDir = join(outputDir, sessionName, 'frames-vfr')
	ensureDir(framesDir, true)

	const { allFrames, totalBatches, batchDetails } = extractFrames(batchBuffers)
	if (allFrames.length === 0) {
		console.log('  No frames found — skipping')
		return null
	}

	const { maxW, maxH, hasVaryingSizes } = await resolveCanvasSize(allFrames)

	const fps = opts.fps || DEFAULT_FPS
	const timeSpanMs = computeTimeSpan(allFrames)
	const effectiveTimeSpanMs = computeEffectiveTimeSpan(allFrames)
	const frameDurationMs = 1000 / fps
	const totalVideoFrames = Math.ceil(effectiveTimeSpanMs / frameDurationMs) + 1

	console.log(`  Total: ${allFrames.length} source frames from ${totalBatches} batches`)
	console.log(`  Video canvas size: ${maxW}x${maxH}${hasVaryingSizes ? ' (frames have varying sizes)' : ''}`)
	console.log(`  Time span: ${(timeSpanMs / 1000).toFixed(1)}s (effective: ${(effectiveTimeSpanMs / 1000).toFixed(1)}s with idle clamping)`)
	console.log(`  Mode: VFR v1 (timestamp-based CFR at ${fps}fps)`)
	console.log(`  Output: ${totalVideoFrames} video frames at ${fps}fps`)

	const sourceFramePaths = await writeSourceFrames(allFrames, framesDir, maxW, maxH, hasVaryingSizes)

	const sourceEffectiveTimes = buildEffectiveTimeline(allFrames)
	const videoFrameCount = mapVideoFrames(
		allFrames, sourceFramePaths, sourceEffectiveTimes, framesDir, frameDurationMs, totalVideoFrames
	)

	const manifest = buildManifest(
		sessionName, totalBatches, allFrames, timeSpanMs, effectiveTimeSpanMs,
		fps, videoFrameCount, maxW, maxH, batchDetails, sourceEffectiveTimes
	)
	const manifestPath = join(outputDir, sessionName, 'manifest.json')
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

	console.log(`  Wrote ${videoFrameCount} video frames (from ${allFrames.length} source frames) + manifest.json`)

	const outputVideo = join(outputDir, sessionName, `${sessionName}.mp4`)
	const result = runFfmpeg([
		'-y',
		'-framerate', String(fps),
		'-i', join(framesDir, 'frame-%05d.webp'),
		'-c:v', 'libx264',
		'-pix_fmt', 'yuv420p',
		'-crf', '28',
		'-preset', 'fast',
		outputVideo,
	], outputVideo)

	if (!result) return null

	return {
		videoPath: outputVideo,
		framesDir,
		manifestPath,
		frameCount: allFrames.length,
		videoFrameCount,
		videoSizeBytes: result.videoSizeBytes,
		manifest,
	}
}

function mapVideoFrames(allFrames, sourceFramePaths, sourceEffectiveTimes, framesDir, frameDurationMs, totalVideoFrames) {
	let sourceIdx = 0
	let count = 0

	for (let vi = 0; vi < totalVideoFrames; vi++) {
		const videoTimeMs = vi * frameDurationMs
		while (sourceIdx + 1 < allFrames.length && sourceEffectiveTimes[sourceIdx + 1] <= videoTimeMs) {
			sourceIdx++
		}
		const outPath = join(framesDir, `frame-${String(vi).padStart(5, '0')}.webp`)
		copyFileSync(sourceFramePaths[sourceIdx], outPath)
		count++
	}
	return count
}

function buildManifest(sessionName, totalBatches, allFrames, timeSpanMs, effectiveTimeSpanMs, fps, videoFrameCount, maxW, maxH, batchDetails, sourceEffectiveTimes) {
	return {
		session: sessionName,
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
	id: 'vfr-v1',
	name: 'Variable Frame v1',
	description: 'Idle gap clamping (10s max), frame duplication at 5fps, crf 28, preset fast.',
	convert,
})
