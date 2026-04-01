/**
 * Variable Frame v5 — AV1 optimized for screen recording with still-picture tuning.
 *
 * Uses the FFmpeg concat demuxer for true VFR (one video frame per source frame,
 * no redundant frame duplication). Builds on v4 with key improvements:
 *
 *   - `-tune ssim`           preserves sharp edges on text and UI elements
 *   - CRF 28 (vs v4's 32)   higher quality for static screen content
 *   - `-cpu-used 4`          better compression vs v4's speed-6 (slower but worth it)
 *   - `-vf scale/pad`        normalises all frames to 1080p, preventing encoder errors
 *                            when screenshot dimensions vary slightly
 *
 * Output: MP4 container with AV1 video. Broad browser support
 * (Chrome 70+, Firefox 67+, Edge 79+, Safari 17+).
 */

import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { registerStrategy } from './strategy-registry.mjs'
import {
	ensureDir, extractFrames, resolveCanvasSize,
	writeSourceFrames, runFfmpeg,
	computeTimeSpan, computeEffectiveTimeSpan, buildEffectiveTimeline,
} from './pipeline.mjs'

const TARGET_WIDTH = 1920
const TARGET_HEIGHT = 1080

async function convert(batchBuffers, sessionName, opts = {}) {
	const outputDir = opts.outputDir || './output'
	const framesDir = join(outputDir, sessionName, 'frames-vfr-v5')
	ensureDir(framesDir, true)

	const { allFrames, totalBatches, batchDetails } = extractFrames(batchBuffers)
	if (allFrames.length === 0) {
		console.log('  No frames found — skipping')
		return null
	}

	const { maxW, maxH, hasVaryingSizes } = await resolveCanvasSize(allFrames)

	const timeSpanMs = computeTimeSpan(allFrames)
	const effectiveTimeSpanMs = computeEffectiveTimeSpan(allFrames)
	const sourceEffectiveTimes = buildEffectiveTimeline(allFrames)
	const totalVideoFrames = allFrames.length

	console.log(`  Total: ${allFrames.length} source frames from ${totalBatches} batches`)
	console.log(`  Source canvas: ${maxW}x${maxH}${hasVaryingSizes ? ' (varying)' : ''}`)
	console.log(`  Output target: ${TARGET_WIDTH}x${TARGET_HEIGHT} (scale + pad)`)
	console.log(`  Time span: ${(timeSpanMs / 1000).toFixed(1)}s (effective: ${(effectiveTimeSpanMs / 1000).toFixed(1)}s)`)
	console.log(`  Mode: VFR v5 (concat demuxer, AV1 tune=ssim, true VFR)`)

	const sourceFramePaths = await writeSourceFrames(allFrames, framesDir, maxW, maxH, hasVaryingSizes)

	const concatPath = join(framesDir, 'concat.txt')
	const concatContent = buildConcatFile(sourceFramePaths, sourceEffectiveTimes)
	writeFileSync(concatPath, concatContent, 'utf-8')

	console.log(`  Wrote ${allFrames.length} source frames + concat.txt (no frame duplication)`)

	// Scale to fit within 1080p while preserving aspect ratio, then pad to exact 1080p.
	// This handles varying input dimensions gracefully and ensures the encoder
	// always receives uniform frames.
	const vf = [
		`scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease`,
		`pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`,
		'format=yuv420p',
	].join(',')

	const outputVideo = join(outputDir, sessionName, `${sessionName}.mp4`)
	const result = runFfmpeg([
		'-y',
		'-f', 'concat',
		'-safe', '0',
		'-i', concatPath,
		'-vf', `'${vf}'`,
		'-c:v', 'libaom-av1',
		'-vsync', 'vfr',
		'-crf', '28',
		'-b:v', '0',
		'-cpu-used', '4',
		'-row-mt', '1',
		'-tiles', '2x2',
		'-tune', 'ssim',
		'-movflags', '+faststart',
		outputVideo,
	], outputVideo)

	if (!result) return null

	const manifest = buildManifest(
		sessionName, totalBatches, allFrames, timeSpanMs, effectiveTimeSpanMs,
		totalVideoFrames, maxW, maxH, batchDetails, sourceEffectiveTimes
	)
	const manifestPath = join(outputDir, sessionName, 'manifest-v5.json')
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

	// ffmpeg concat demuxer requires the last file repeated without duration
	lines.push(`file ${sourceFramePaths.at(-1)}`)
	return lines.join('\n')
}

function buildManifest(sessionName, totalBatches, allFrames, timeSpanMs, effectiveTimeSpanMs, videoFrameCount, maxW, maxH, batchDetails, sourceEffectiveTimes) {
	return {
		session: sessionName,
		strategy: 'vfr-v5',
		totalBatches,
		totalFrames: allFrames.length,
		timeSpanMs,
		effectiveTimeSpanMs,
		videoFrameCount,
		videoSize: { width: TARGET_WIDTH, height: TARGET_HEIGHT },
		sourceSize: { width: maxW, height: maxH },
		encoding: {
			codec: 'libaom-av1',
			crf: 28,
			cpuUsed: 4,
			tune: 'ssim',
			tiles: '2x2',
			rowMt: true,
		},
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
	id: 'vfr-v5',
	name: 'Variable Frame v5',
	description: 'AV1 SSIM-tuned, 1080p normalized, CRF 28. Best quality for screen recordings.',
	convert,
})
