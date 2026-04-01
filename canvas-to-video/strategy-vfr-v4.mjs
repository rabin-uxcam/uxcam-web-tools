/**
 * Variable Frame v4 — AV1 with concat demuxer.
 *
 * Same concat demuxer approach as v2/v3 (no frame duplication), but uses
 * libaom-av1 for excellent compression. AV1 has broad browser support
 * (Chrome, Firefox, Edge, Safari 17+) unlike HEVC.
 *
 * Trade-off: AV1 encoding is significantly slower than H.264/H.265,
 * but produces the smallest files for screen recording content.
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
	const framesDir = join(outputDir, sessionName, 'frames-vfr-v4')
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
	const totalVideoFrames = allFrames.length

	console.log(`  Total: ${allFrames.length} source frames from ${totalBatches} batches`)
	console.log(`  Video canvas size: ${maxW}x${maxH}${hasVaryingSizes ? ' (varying)' : ''}`)
	console.log(`  Time span: ${(timeSpanMs / 1000).toFixed(1)}s (effective: ${(effectiveTimeSpanMs / 1000).toFixed(1)}s)`)
	console.log(`  Mode: VFR v4 (concat demuxer, AV1, true VFR output)`)

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
		'-c:v', 'libaom-av1',
		'-pix_fmt', 'yuv420p',
		'-vsync', 'vfr',
		'-crf', '32',
		'-cpu-used', '6',
		'-row-mt', '1',
		'-tiles', '2x2',
		'-movflags', '+faststart',
		outputVideo,
	], outputVideo)

	if (!result) return null

	const manifest = buildManifest(
		sessionName, totalBatches, allFrames, timeSpanMs, effectiveTimeSpanMs,
		fps, totalVideoFrames, maxW, maxH, batchDetails, sourceEffectiveTimes
	)
	const manifestPath = join(outputDir, sessionName, 'manifest-v4.json')
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
		strategy: 'vfr-v4',
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
				? allFrames[i + 1].time - f.time
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
	id: 'vfr-v4',
	name: 'Variable Frame v4',
	description: 'AV1 codec, concat demuxer, true VFR. Best compression, broad browser support, slow encoding.',
	convert,
})
