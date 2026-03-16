/**
 * Constant Frame v1 — extracted from the original processSession().
 *
 * Duplicates frames at a fixed FPS to fill the timeline, then encodes
 * with a simple sequential image-sequence ffmpeg pipeline.
 */

import { join } from 'node:path'
import { copyFileSync } from 'node:fs'
import { registerStrategy } from './strategy-registry.mjs'
import {
	ensureDir, extractFrames, resolveCanvasSize,
	writeSourceFrames, runFfmpeg, computeTimeSpan,
} from './pipeline.mjs'

const DEFAULT_FPS = 3

async function convert(batchBuffers, sessionName, opts = {}) {
	const outputDir = opts.outputDir || './output'
	const framesDir = join(outputDir, sessionName, 'frames')
	ensureDir(framesDir, true)

	const { allFrames, totalBatches } = extractFrames(batchBuffers)
	if (allFrames.length === 0) {
		console.log('  No frames found — skipping')
		return null
	}

	const { maxW, maxH, hasVaryingSizes } = await resolveCanvasSize(allFrames)

	const fps = opts.fps || DEFAULT_FPS
	const timeSpanMs = computeTimeSpan(allFrames)
	const frameDurationMs = 1000 / fps
	const startTime = allFrames[0].time
	const totalVideoFrames = Math.ceil(timeSpanMs / frameDurationMs) + 1

	console.log(`  Total: ${allFrames.length} source frames from ${totalBatches} batches`)
	console.log(`  Video canvas size: ${maxW}x${maxH}${hasVaryingSizes ? ' (frames have varying sizes)' : ''}`)
	console.log(`  Time span: ${(timeSpanMs / 1000).toFixed(1)}s`)
	console.log(`  Output: ${totalVideoFrames} video frames at ${fps}fps`)

	const sourceFramePaths = await writeSourceFrames(allFrames, framesDir, maxW, maxH, hasVaryingSizes)

	const videoFrameCount = duplicateFrames(
		allFrames, sourceFramePaths, framesDir, frameDurationMs, startTime, totalVideoFrames
	)

	console.log(`  Wrote ${videoFrameCount} video frames (from ${allFrames.length} source frames)`)

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
		frameCount: allFrames.length,
		videoFrameCount,
		videoSizeBytes: result.videoSizeBytes,
	}
}

function duplicateFrames(allFrames, sourceFramePaths, framesDir, frameDurationMs, startTime, totalVideoFrames) {
	let sourceIdx = 0
	let count = 0

	for (let vi = 0; vi < totalVideoFrames; vi++) {
		const videoTimeMs = startTime + vi * frameDurationMs
		while (sourceIdx + 1 < allFrames.length && allFrames[sourceIdx + 1].time <= videoTimeMs) {
			sourceIdx++
		}
		const outPath = join(framesDir, `frame-${String(vi).padStart(5, '0')}.webp`)
		copyFileSync(sourceFramePaths[sourceIdx], outPath)
		count++
	}
	return count
}

registerStrategy({
	id: 'cfr-v1',
	name: 'Constant Frame v1',
	description: 'Duplicates frames at fixed FPS (default 3). Simple sequential encoding with crf 28.',
	convert,
})
