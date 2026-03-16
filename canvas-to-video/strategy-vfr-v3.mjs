/**
 * Variable Frame v3 — H.265/HEVC with true VFR output.
 *
 * Same concat demuxer approach as v2 (no frame duplication), but uses
 * libx265 for ~30-40% better compression on screen recordings, and
 * -vsync vfr for true variable frame rate output.
 *
 * Trade-off: HEVC browser support is inconsistent (Safari yes, Chrome
 * hardware-only, Firefox limited). Best for size comparison benchmarks
 * and non-browser playback.
 */

import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { registerStrategy } from './strategy-registry.mjs'
import {
	ensureDir, extractFrames, resolveCanvasSize,
	writeSourceFrames, runFfmpeg,
	computeTimeSpan, computeEffectiveTimeSpan, buildEffectiveTimeline,
} from './pipeline.mjs'

const DEFAULT_FPS = 3

async function convert(batchBuffers, sessionName, opts = {}) {
	const outputDir = opts.outputDir || './output'
	const framesDir = join(outputDir, sessionName, 'frames-vfr-v3')
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
	const sourceEffectiveTimes = buildEffectiveTimeline(allFrames)
	const totalVideoFrames = allFrames.length // true VFR: 1 video frame per source frame

	console.log(`  Total: ${allFrames.length} source frames from ${totalBatches} batches`)
	console.log(`  Video canvas size: ${maxW}x${maxH}${hasVaryingSizes ? ' (varying)' : ''}`)
	console.log(`  Time span: ${(timeSpanMs / 1000).toFixed(1)}s (effective: ${(effectiveTimeSpanMs / 1000).toFixed(1)}s)`)
	console.log(`  Mode: VFR v3 (concat demuxer, libx265, true VFR output)`)

	const sourceFramePaths = await writeSourceFrames(allFrames, framesDir, maxW, maxH, hasVaryingSizes)

	const concatPath = join(framesDir, 'concat.txt')
	const concatContent = buildConcatFile(sourceFramePaths, sourceEffectiveTimes)
	writeFileSync(concatPath, concatContent, 'utf-8')

	console.log(`  Wrote ${allFrames.length} source frames + concat.txt (no frame duplication)`)

	const outputVideo = join(outputDir, sessionName, `${sessionName}.mp4`)
	const result = runFfmpeg([
		'-y',
		'-f', 'concat',
		'-safe', '0',
		'-i', concatPath,
		'-c:v', 'libx265',
		'-pix_fmt', 'yuv420p',
		'-vsync', 'vfr',
		'-crf', '28',
		'-preset', 'slower',
		'-tag:v', 'hvc1',
		'-movflags', '+faststart',
		outputVideo,
	], outputVideo)

	if (!result) return null

	const manifest = buildManifest(
		sessionName, totalBatches, allFrames, timeSpanMs, effectiveTimeSpanMs,
		fps, totalVideoFrames, maxW, maxH, batchDetails, sourceEffectiveTimes
	)
	const manifestPath = join(outputDir, sessionName, 'manifest-v3.json')
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
			: 0.5
		lines.push(`file ${sourceFramePaths[i]}`)
		lines.push(`duration ${durationSec.toFixed(6)}`)
	}

	lines.push(`file ${sourceFramePaths.at(-1)}`)
	return lines.join('\n')
}

function buildManifest(sessionName, totalBatches, allFrames, timeSpanMs, effectiveTimeSpanMs, fps, videoFrameCount, maxW, maxH, batchDetails, sourceEffectiveTimes) {
	return {
		session: sessionName,
		strategy: 'vfr-v3',
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
	id: 'vfr-v3',
	name: 'Variable Frame v3',
	description: 'H.265/HEVC, concat demuxer, true VFR, crf 28, preset slower. Smallest but limited browser support.',
	convert,
})
