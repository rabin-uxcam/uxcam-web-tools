/**
 * bin-processor-variants.mjs — Optimization variants of the production bin-processor
 *
 * Each variant applies a specific optimization to measure its impact on:
 *   - Encoding time (wall clock)
 *   - Peak Node.js memory (RSS + heap + external)
 *   - Peak FFmpeg memory (via PID monitoring)
 *   - Output video file size
 *
 * All variants share the same parsing/frame-writing pipeline,
 * differing only in the FFmpeg args and memory-management strategy.
 */

import { spawn, execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, statSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import sharp from 'sharp'
import { parseBatch } from './parse-batch.mjs'

const LAST_FRAME_HOLD_MS = 500

// ─── Variant definitions ────────────────────────────────────────────────────

export const VARIANTS = [
  {
    id: 'baseline',
    name: 'Baseline (pre-optimization)',
    description: 'Previous production settings: libx265, preset slower, quality 100',
    ffmpegArgs: (concatPath, outputVideo) => [
      '-y', '-fflags', '+genpts', '-f', 'concat', '-safe', '0', '-i', concatPath,
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-vsync', 'vfr',
      '-crf', '28', '-preset', 'slower',
      '-tag:v', 'hvc1', '-x265-params', 'keyint=60:min-keyint=30',
      '-movflags', '+faststart',
      outputVideo,
    ],
    webpQuality: 100,
    freeBuffers: false,
  },
  {
    id: 'h264-fast',
    name: 'H.264 + preset fast',
    description: 'Switch to libx264 with preset fast and stillimage tune',
    ffmpegArgs: (concatPath, outputVideo) => [
      '-y', '-fflags', '+genpts', '-f', 'concat', '-safe', '0', '-i', concatPath,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vsync', 'vfr',
      '-crf', '28', '-preset', 'fast', '-tune', 'stillimage',
      '-movflags', '+faststart',
      outputVideo,
    ],
    webpQuality: 100,
    freeBuffers: false,
  },
  {
    id: 'h265-fast',
    name: 'H.265 + preset fast (current production)',
    description: 'libx265 with preset fast — current production config',
    ffmpegArgs: (concatPath, outputVideo) => [
      '-y', '-fflags', '+genpts', '-f', 'concat', '-safe', '0', '-i', concatPath,
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-vsync', 'vfr',
      '-crf', '28', '-preset', 'fast',
      '-tag:v', 'hvc1', '-x265-params', 'keyint=60:min-keyint=30',
      '-movflags', '+faststart',
      outputVideo,
    ],
    webpQuality: 80,
    freeBuffers: true,
  },
  {
    id: 'h265-threads2',
    name: 'H.265 slower + threads 2',
    description: 'Pre-optimization baseline + limit FFmpeg to 2 threads',
    ffmpegArgs: (concatPath, outputVideo) => [
      '-y', '-fflags', '+genpts', '-f', 'concat', '-safe', '0', '-i', concatPath,
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-vsync', 'vfr',
      '-crf', '28', '-preset', 'slower', '-threads', '2',
      '-tag:v', 'hvc1', '-x265-params', 'keyint=60:min-keyint=30',
      '-movflags', '+faststart',
      outputVideo,
    ],
    webpQuality: 100,
    freeBuffers: false,
  },
  {
    id: 'h265-memfree',
    name: 'H.265 slower + free buffers',
    description: 'Pre-optimization baseline + release frame buffers after writing to disk',
    ffmpegArgs: (concatPath, outputVideo) => [
      '-y', '-fflags', '+genpts', '-f', 'concat', '-safe', '0', '-i', concatPath,
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-vsync', 'vfr',
      '-crf', '28', '-preset', 'slower',
      '-tag:v', 'hvc1', '-x265-params', 'keyint=60:min-keyint=30',
      '-movflags', '+faststart',
      outputVideo,
    ],
    webpQuality: 100,
    freeBuffers: true,
  },
  {
    id: 'h265-q80',
    name: 'H.265 slower + quality 80',
    description: 'Pre-optimization baseline + reduce intermediate WebP quality from 100 to 80',
    ffmpegArgs: (concatPath, outputVideo) => [
      '-y', '-fflags', '+genpts', '-f', 'concat', '-safe', '0', '-i', concatPath,
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-vsync', 'vfr',
      '-crf', '28', '-preset', 'slower',
      '-tag:v', 'hvc1', '-x265-params', 'keyint=60:min-keyint=30',
      '-movflags', '+faststart',
      outputVideo,
    ],
    webpQuality: 80,
    freeBuffers: false,
  },
  {
    id: 'optimized',
    name: 'All optimizations combined',
    description: 'H.264 fast + stillimage + threads 2 + free buffers + quality 80',
    ffmpegArgs: (concatPath, outputVideo) => [
      '-y', '-fflags', '+genpts', '-f', 'concat', '-safe', '0', '-i', concatPath,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vsync', 'vfr',
      '-crf', '28', '-preset', 'fast', '-tune', 'stillimage',
      '-threads', '2',
      '-movflags', '+faststart',
      outputVideo,
    ],
    webpQuality: 80,
    freeBuffers: true,
  },
]

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Run a single optimization variant and return metrics.
 *
 * @param {string} variantId - One of VARIANTS[].id
 * @param {{ name: string, buffer: Buffer }[]} batchBuffers
 * @param {string} sessionId
 * @param {string} outputDir
 * @returns {Promise<object>} metrics
 */
export async function runVariant(variantId, batchBuffers, sessionId, outputDir) {
  const variant = VARIANTS.find((v) => v.id === variantId)
  if (!variant) throw new Error(`Unknown variant: ${variantId}`)

  const label = `${sessionId}--${variantId}`
  const workDir = resolve(outputDir, `${label}`, 'frames')
  const videoDir = resolve(outputDir, `${label}`)
  mkdirSync(workDir, { recursive: true })

  // Memory tracking
  const memSamples = { nodeRss: 0, nodeHeap: 0, nodeExternal: 0, ffmpegRss: 0 }

  const memInterval = setInterval(() => {
    const mem = process.memoryUsage()
    memSamples.nodeRss = Math.max(memSamples.nodeRss, mem.rss)
    memSamples.nodeHeap = Math.max(memSamples.nodeHeap, mem.heapUsed)
    memSamples.nodeExternal = Math.max(memSamples.nodeExternal, mem.external)
  }, 100)

  const startTime = Date.now()

  try {
    // a) Parse
    const allFrames = parseBatchBuffers(batchBuffers)
    if (allFrames.length === 0) {
      return { variantId, error: 'No frames found', metrics: null }
    }

    // b) Sort
    allFrames.sort((a, b) => a.time - b.time)

    // c) Dimensions
    const { maxW, maxH, hasVaryingSizes } = await resolveDimensions(allFrames)

    // d) Timeline
    const effectiveTimes = buildEffectiveTimeline(allFrames)

    // e) Write frames (with optional buffer release)
    await writeFrames(allFrames, workDir, maxW, maxH, hasVaryingSizes, variant.webpQuality, variant.freeBuffers)

    // f) Concat file
    const concatPath = join(workDir, 'concat.txt')
    writeFileSync(concatPath, buildConcatFile(allFrames.length, workDir, effectiveTimes), 'utf-8')

    // g) FFmpeg encode with PID monitoring
    const outputVideo = join(videoDir, `${sessionId}.mp4`)
    const ffmpegResult = await runFfmpegWithMonitoring(
      variant.ffmpegArgs(concatPath, outputVideo),
      memSamples,
    )

    if (ffmpegResult.error) {
      return { variantId, error: ffmpegResult.error, metrics: null }
    }

    const encodingTimeMs = Date.now() - startTime
    const videoSizeBytes = statSync(outputVideo).size

    return {
      variantId,
      name: variant.name,
      description: variant.description,
      error: null,
      videoUrl: `/output/${label}/${sessionId}.mp4`,
      metrics: {
        encodingTimeMs,
        videoSizeBytes,
        frameCount: allFrames.length,
        dimensions: { width: maxW, height: maxH },
        peakNodeRssMB: (memSamples.nodeRss / 1024 / 1024).toFixed(1),
        peakNodeHeapMB: (memSamples.nodeHeap / 1024 / 1024).toFixed(1),
        peakNodeExternalMB: (memSamples.nodeExternal / 1024 / 1024).toFixed(1),
        peakFfmpegRssMB: (memSamples.ffmpegRss / 1024 / 1024).toFixed(1),
        estimatedTotalPeakMB: ((memSamples.nodeRss + memSamples.ffmpegRss) / 1024 / 1024).toFixed(1),
      },
    }
  } catch (err) {
    return { variantId, error: err.message, metrics: null }
  } finally {
    clearInterval(memInterval)
    // Cleanup frames dir, keep the video
    if (existsSync(workDir)) {
      rmSync(workDir, { recursive: true })
    }
  }
}

/**
 * Run ALL variants sequentially for a fair comparison.
 */
export async function runAllVariants(batchBuffers, sessionId, outputDir) {
  const results = []
  for (const variant of VARIANTS) {
    console.log(`\n[benchmark-bin] Running variant: ${variant.name}`)

    // Force GC between variants if available
    if (global.gc) global.gc()

    const result = await runVariant(variant.id, batchBuffers, sessionId, outputDir)
    results.push(result)

    console.log(
      result.error
        ? `  ✗ ${variant.id}: ${result.error}`
        : `  ✓ ${variant.id}: ${result.metrics.encodingTimeMs}ms, ` +
          `${(result.metrics.videoSizeBytes / 1024 / 1024).toFixed(2)}MB video, ` +
          `~${result.metrics.estimatedTotalPeakMB}MB peak memory`
    )
  }
  return results
}

// ─── Batch parsing (uses parse-batch.mjs for all format support) ────────────

function parseBatchBuffers(batchBuffers) {
  const allFrames = []
  for (const { name, buffer } of batchBuffers) {
    try {
      const raw = decompressBuffer(buffer)
      const batch = parseBatch(raw)
      for (const frame of batch.frames) {
        // Skip end-marker frames (empty data, w=0, h=0)
        if (frame.data.length === 0 && frame.width === 0 && frame.height === 0) continue
        allFrames.push({
          time: frame.time,
          width: frame.width,
          height: frame.height,
          data: Buffer.from(frame.data),
        })
      }
    } catch (err) {
      console.warn(`  [parse] Failed to parse ${name}: ${err.message} — skipping`)
    }
  }
  return allFrames
}

function decompressBuffer(buffer) {
  try { return gunzipSync(buffer) } catch { return buffer }
}

// ─── Dimension resolution ───────────────────────────────────────────────────

async function resolveDimensions(allFrames) {
  if (allFrames.some((f) => f.width === 0 || f.height === 0)) {
    const meta = await sharp(allFrames[0].data).metadata()
    const fallbackW = meta.width || 0
    const fallbackH = meta.height || 0
    for (const f of allFrames) {
      if (f.width === 0) f.width = fallbackW
      if (f.height === 0) f.height = fallbackH
    }
  }
  let maxW = 0, maxH = 0
  for (const f of allFrames) {
    if (f.width > maxW) maxW = f.width
    if (f.height > maxH) maxH = f.height
  }
  if (maxW % 2 !== 0) maxW++
  if (maxH % 2 !== 0) maxH++
  const hasVaryingSizes = allFrames.some((f) => f.width !== allFrames[0].width || f.height !== allFrames[0].height)
  return { maxW, maxH, hasVaryingSizes }
}

// ─── Timeline ───────────────────────────────────────────────────────────────

function buildEffectiveTimeline(allFrames) {
  const effectiveTimes = [0]
  for (let i = 1; i < allFrames.length; i++) {
    effectiveTimes.push(allFrames[i].time - allFrames[0].time)
  }
  return effectiveTimes
}

// ─── Frame writing (with quality + buffer-free options) ─────────────────────

async function writeFrames(allFrames, workDir, maxW, maxH, hasVaryingSizes, webpQuality, freeBuffers) {
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
          .webp({ quality: webpQuality })
          .toFile(framePath)
      } else {
        await sharp(frame.data).webp({ quality: webpQuality }).toFile(framePath)
      }
    } else {
      writeFileSync(framePath, allFrames[i].data)
    }

    // Release frame buffer after writing — reduces memory for long sessions
    if (freeBuffers) {
      allFrames[i].data = Buffer.alloc(0)
    }
  }
}

// ─── Concat file ────────────────────────────────────────────────────────────

function buildConcatFile(frameCount, workDir, effectiveTimes) {
  const lines = ['ffconcat version 1.0']
  for (let i = 0; i < frameCount; i++) {
    const durationSec = i + 1 < frameCount
      ? (effectiveTimes[i + 1] - effectiveTimes[i]) / 1000
      : LAST_FRAME_HOLD_MS / 1000
    lines.push(`file ${join(workDir, `src-${String(i).padStart(5, '0')}.webp`)}`)
    lines.push(`duration ${durationSec.toFixed(6)}`)
  }
  lines.push(`file ${join(workDir, `src-${String(frameCount - 1).padStart(5, '0')}.webp`)}`)
  return lines.join('\n')
}

// ─── FFmpeg with PID-based memory monitoring ────────────────────────────────

function runFfmpegWithMonitoring(args, memSamples) {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', args)
    let stderrChunks = []
    let monitorInterval = null

    // Monitor FFmpeg RSS via /proc (Linux) or ps (macOS)
    if (proc.pid) {
      monitorInterval = setInterval(() => {
        try {
          let rssBytes = 0
          try {
            // Linux/Docker (Alpine): read from /proc — works with BusyBox
            const statusContent = readFileSync(`/proc/${proc.pid}/status`, 'utf-8')
            const vmRssMatch = statusContent.match(/VmRSS:\s+(\d+)\s+kB/)
            if (vmRssMatch) rssBytes = parseInt(vmRssMatch[1], 10) * 1024
          } catch {
            // macOS fallback: ps -o rss=
            const rssKB = execSync(`ps -o rss= -p ${proc.pid} 2>/dev/null`, { encoding: 'utf-8' }).trim()
            if (rssKB) rssBytes = parseInt(rssKB, 10) * 1024
          }
          if (rssBytes > 0) {
            memSamples.ffmpegRss = Math.max(memSamples.ffmpegRss, rssBytes)
          }
        } catch {
          // Process may have exited
        }
      }, 200)
    }

    proc.stderr.on('data', (data) => {
      stderrChunks.push(data)
    })

    proc.on('close', (code) => {
      if (monitorInterval) clearInterval(monitorInterval)
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString()
        resolve({ error: `FFmpeg exited with code ${code}: ${stderr.slice(-500)}` })
      } else {
        resolve({ error: null })
      }
    })

    proc.on('error', (err) => {
      if (monitorInterval) clearInterval(monitorInterval)
      resolve({ error: `Failed to spawn ffmpeg: ${err.message}` })
    })
  })
}
