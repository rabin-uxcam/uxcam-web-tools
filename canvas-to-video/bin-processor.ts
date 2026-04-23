import { spawn } from 'child_process'
import { writeFileSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { gunzipSync } from 'zlib'
import sharp from 'sharp'

import { createLogger } from '../lib/logger'
import { deleteFolder } from '../lib/delete-folder'
import { FfmpegEncodeError, QueryReadTimeoutError } from '../lib/errors'
import { rollbar } from '../lib/rollbar'
import { S3Service } from './s3-service'
import { StatsService } from './stats-service'
import { KinesisService } from './kinesis-service'
import { MongoId, toStringId } from '../models/mongo'
import { constructS3PathForVideoFile, getTemporaryDownloadFolderName } from '../models/s3'
import { SessionVideoRecord, createSessionVideoRecord } from '../models/session'
import { DevicePlatform } from '../models/device'
import { isQueryTimeoutError, PgRepository } from '../respository/pg'
import { CacheRepository } from '../respository/cache'
import { config } from '../config'

export interface BatchBuffer {
  name: string
  buffer: Buffer
}

export interface ParsedFrame {
  time: number
  width: number
  height: number
  data: Buffer
}

export interface BinProcessingService {
  process(batchBuffers: BatchBuffer[], orgId: MongoId, appId: MongoId, sessionId: MongoId, bucket: string): Promise<void>
}

const LAST_FRAME_HOLD_MS = 500

export function BinProcessingService(
  s3Service: S3Service,
  ffmpegBinaryPath: string,
  tempDownloadFolder: string,
  pgRepository: PgRepository,
  statsService: StatsService,
  kinesisService: KinesisService,
  cacheRepository: CacheRepository,
): BinProcessingService {
  const logger = createLogger(BinProcessingService)

  async function process(batchBuffers: BatchBuffer[], orgId: MongoId, appId: MongoId, sessionId: MongoId, bucket: string): Promise<void> {
    const log = logger.child({ orgId, appId, sessionId })

    // a) Parse batch buffers → frames
    const allFrames = parseBatchBuffers(batchBuffers)
    if (allFrames.length === 0) {
      log.info('No frames found in batch buffers, returning')
      return
    }

    // b) Sort frames by timestamp
    allFrames.sort((a, b) => a.time - b.time)

    // c) Resolve dimensions
    const { maxW, maxH, hasVaryingSizes } = await resolveDimensions(allFrames)
    log.info({ frameCount: allFrames.length, maxW, maxH, hasVaryingSizes }, 'Resolved frame dimensions')

    // d) Build effective timeline (gap capping)
    const effectiveTimes = buildEffectiveTimeline(allFrames)

    // e) Write frames to /tmp
    const workDir = `${tempDownloadFolder}/${getTemporaryDownloadFolderName(sessionId)}`
    mkdirSync(workDir, { recursive: true })

    try {
      await writeFrames(allFrames, workDir, maxW, maxH, hasVaryingSizes)

      // f) Build concat.txt
      const concatPath = join(workDir, 'concat.txt')
      writeFileSync(concatPath, buildConcatFile(allFrames.length, workDir, effectiveTimes), 'utf-8')

      // g) FFmpeg encode
      const outputVideo = join(workDir, `${sessionId}.mp4`)
      log.info('Starting FFmpeg encode')
      await runFfmpeg(ffmpegBinaryPath, concatPath, outputVideo)
      log.info('FFmpeg encode complete')

      // h) Upload to S3
      const s3Key = constructS3PathForVideoFile(orgId, appId, sessionId)
      const fileStat = statSync(outputVideo)
      log.info({ s3Key, bucket, localFileSize: fileStat.size }, 'Uploading video to S3')
      await s3Service.uploadFile(outputVideo, bucket, s3Key, 'video/mp4')

      // Verify upload
      const exists = await s3Service.doesObjectExist(bucket, s3Key)
      log.info({ s3Key, bucket, exists }, 'Video upload verification')

      // --- Post-upload processing (DB, cache, Kinesis) ---
      log.info('Starting post-upload processing')

      // 1. Get uploadedTime from Redis cache, with fallback
      const uploadedOnFromCache = await cacheRepository.getUploadedOn(sessionId)
      const uploadedTime = uploadedOnFromCache || new Date().toISOString()

      // 2. Mark video as available in Citus (PG)
      try {
        await pgRepository.markVideoAsAvailable(toStringId(appId), toStringId(sessionId), uploadedTime)
      } catch (error) {
        log.error(error, 'Error while updating session row to mark video as available')
        if (isQueryTimeoutError(error)) {
          throw new QueryReadTimeoutError()
        }
        throw error
      }

      // 3. Add to Redis Bloom Filter
      try {
        log.info('Adding video to BF')
        await cacheRepository.setVideoAlreadyProcessed(sessionId)
      } catch (error) {
        const msg = 'Error while adding video to BF'
        log.error({ error }, msg)
        rollbar.error({ error, orgId, appId, sessionId }, msg)
      }

      // 4. Determine Kinesis stream and push session video record
      const stats = await statsService.getCurrentStatsByOrgId(orgId)
      const currentDebugSessionCount = stats && stats.webSession ? stats.webSession : 0
      const shouldSendToDebugPipeline = currentDebugSessionCount < config.totalDebugSessionAllowedPerMonth
      const videoStream = shouldSendToDebugPipeline ? config.kinesis.debugStreamName : config.kinesis.sessionStreamName

      const sessionVideo = createSessionVideoRecord(orgId, appId, sessionId, uploadedTime)
      try {
        log.info({ stream: videoStream }, 'Pushing sessionvideo to kinesis')
        await kinesisService.putRecord<SessionVideoRecord>(videoStream, sessionVideo, 'sessionvideo')
      } catch (error) {
        const msg = 'Failed to push session replay json to kinesis'
        rollbar.error(msg, error, { orgId, appId, sessionId })
        log.error({ error }, msg)
      }

      // 5. Increment video count in Mongo
      log.info('Increasing video count')
      try {
        await statsService.incrementOrganizationVideoCount(orgId, appId, 1, DevicePlatform.Web)
      } catch (error) {
        const msg = 'Error while incrementing processed video count'
        rollbar.error(error, msg, { appId, sessionId, orgId })
        log.error(error, msg)
      }
    } finally {
      // i) Cleanup
      await deleteFolder(workDir)
    }
  }

  return { process }
}

/**
 * Parse all batch buffers into frames.
 *
 * Wire format (produced by packBatch):
 *   [4-byte gzipped-JSON len (big-endian)][gzipped JSON metadata][raw WebP blobs]
 *   JSON: [{ t, sz, w, h, s }, ...]
 *     s = session start epoch (ms). Redundant per-frame so any bin can self-anchor,
 *         even when earlier bins are missing.
 *
 * The .bin files stored in S3 may be gzipped at the outer level,
 * so we attempt outer decompression first before parsing the inner binary format.
 */
function parseBatchBuffers(batchBuffers: BatchBuffer[]): ParsedFrame[] {
  const allFrames: ParsedFrame[] = []
  const log = createLogger('parseBatchBuffers')
  const startTimesSeen = new Set<number>()

  for (const { name, buffer } of batchBuffers) {
    log.info({ name, bufferSize: buffer.length }, 'Processing bin file')

    try {
      // Outer decompression — S3-stored .bin files may be gzipped at the outer level
      const raw = decompressBuffer(buffer)

      const gzippedJsonLen = raw.readUInt32BE(0)
      const gzippedJson = raw.subarray(4, 4 + gzippedJsonLen)
      const jsonBytes = gunzipSync(gzippedJson)
      const meta: Array<{ t: number; sz: number; w: number; h: number; s?: number }> = JSON.parse(new TextDecoder().decode(jsonBytes))

      const dataStart = 4 + gzippedJsonLen
      let cursor = 0

      for (const f of meta) {
        const frameData = raw.subarray(dataStart + cursor, dataStart + cursor + f.sz)
        cursor += f.sz
        allFrames.push({ time: f.t, width: f.w, height: f.h, data: Buffer.from(frameData) })
        if (typeof f.s === 'number' && f.s > 0) startTimesSeen.add(f.s)
      }

      const firstT = meta[0]?.t
      const lastT = meta[meta.length - 1]?.t
      const startTime = meta[0]?.s
      log.info({ name, framesExtracted: meta.length, firstT, lastT, startTime }, 'Parsed batch buffer')
    } catch (err) {
      log.warn({ name, error: (err as Error).message }, 'Failed to parse batch buffer, skipping')
    }
  }

  if (startTimesSeen.size > 1) {
    log.warn({ startTimes: [...startTimesSeen] }, 'Multiple session startTimes observed across bins — timestamps may be misaligned; video pacing will be wrong')
  }

  log.info({ totalFrames: allFrames.length, totalFiles: batchBuffers.length, uniqueStartTimes: startTimesSeen.size }, 'Finished parsing all batch buffers')
  return allFrames
}

/** Try gunzip; return original buffer if not gzipped. */
function decompressBuffer(buffer: Buffer): Buffer {
  try {
    return gunzipSync(buffer)
  } catch {
    return buffer
  }
}

async function resolveDimensions(allFrames: ParsedFrame[]): Promise<{ maxW: number; maxH: number; hasVaryingSizes: boolean }> {
  // Backfill missing dimensions from first frame's WebP metadata
  if (allFrames.some((f) => f.width === 0 || f.height === 0)) {
    const meta = await sharp(allFrames[0].data).metadata()
    const fallbackW = meta.width || 0
    const fallbackH = meta.height || 0
    for (const f of allFrames) {
      if (f.width === 0) f.width = fallbackW
      if (f.height === 0) f.height = fallbackH
    }
  }

  let maxW = 0
  let maxH = 0
  for (const f of allFrames) {
    if (f.width > maxW) maxW = f.width
    if (f.height > maxH) maxH = f.height
  }

  // Codecs require even dimensions
  if (maxW % 2 !== 0) maxW++
  if (maxH % 2 !== 0) maxH++

  const hasVaryingSizes = allFrames.some((f) => f.width !== allFrames[0].width || f.height !== allFrames[0].height)

  return { maxW, maxH, hasVaryingSizes }
}

function buildEffectiveTimeline(allFrames: ParsedFrame[]): number[] {
  const effectiveTimes = [0]
  for (let i = 1; i < allFrames.length; i++) {
    effectiveTimes.push(allFrames[i].time - allFrames[0].time)
  }
  return effectiveTimes
}

async function writeFrames(allFrames: ParsedFrame[], workDir: string, maxW: number, maxH: number, hasVaryingSizes: boolean): Promise<void> {
  // Resize when sizes vary OR when any source frame has odd dimensions
  // (maxW/maxH are already rounded to even by resolveDimensions)
  const needsResize = hasVaryingSizes || allFrames.some((f) => f.width % 2 !== 0 || f.height % 2 !== 0)

  for (let i = 0; i < allFrames.length; i++) {
    const framePath = join(workDir, `src-${String(i).padStart(5, '0')}.webp`)

    if (needsResize) {
      const frame = allFrames[i]
      const padBottom = Math.max(0, maxH - frame.height)
      const padRight = Math.max(0, maxW - frame.width)

      if (padBottom > 0 || padRight > 0) {
        // Center text in the larger visible gray strip (bottom or right)
        const bottomArea = maxW * padBottom
        const rightArea = padRight * frame.height
        let textX: number, textY: number
        if (bottomArea >= rightArea) {
          // Center in bottom strip
          textX = maxW / 2
          textY = frame.height + padBottom / 2
        } else {
          // Center in right strip
          textX = frame.width + padRight / 2
          textY = frame.height / 2
        }
        const fillerSvg = Buffer.from(
          `<svg width="${maxW}" height="${maxH}" xmlns="http://www.w3.org/2000/svg">
						<rect width="${maxW}" height="${maxH}" fill="rgb(193,195,197)"/>
						<text x="${textX}" y="${textY}"
							font-family="Arial, sans-serif" font-size="24" font-weight="bold"
							fill="#ffffff" text-anchor="middle" dominant-baseline="middle">
							Window Resized
						</text>
					</svg>`,
        )
        const fillerBg = await sharp(fillerSvg).webp().toBuffer()

        // Composite the actual frame on top of the gray filler
        await sharp(fillerBg)
          .composite([{ input: frame.data, top: 0, left: 0 }])
          .webp({ quality: 100 })
          .toFile(framePath)
      } else {
        // Frame matches max dimensions but may have odd dimensions — just re-encode
        await sharp(frame.data).webp({ quality: 100 }).toFile(framePath)
      }
    } else {
      writeFileSync(framePath, allFrames[i].data)
    }
  }
}

function buildConcatFile(frameCount: number, workDir: string, effectiveTimes: number[]): string {
  const lines = ['ffconcat version 1.0']

  for (let i = 0; i < frameCount; i++) {
    const durationSec = i + 1 < frameCount ? (effectiveTimes[i + 1] - effectiveTimes[i]) / 1000 : LAST_FRAME_HOLD_MS / 1000

    lines.push(`file ${join(workDir, `src-${String(i).padStart(5, '0')}.webp`)}`)
    lines.push(`duration ${durationSec.toFixed(6)}`)
  }

  // FFmpeg concat demuxer requires the last file repeated without duration
  lines.push(`file ${join(workDir, `src-${String(frameCount - 1).padStart(5, '0')}.webp`)}`)

  return lines.join('\n')
}

function runFfmpeg(ffmpegBinaryPath: string, concatPath: string, outputVideo: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatPath,
      '-c:v',
      'libx265',
      '-pix_fmt',
      'yuv420p',
      // fps_mode=passthrough preserves per-frame durations from the concat
      // demuxer exactly. -vsync vfr (legacy) rounds durations to the output
      // timebase and can compress time at high capture rates.
      '-fps_mode',
      'passthrough',
      // Output timebase at 1ms granularity so 33ms frame durations (30 fps
      // capture) survive without rounding.
      '-video_track_timescale',
      '1000',
      '-crf',
      '28',
      '-preset',
      'slower',
      '-tag:v',
      'hvc1',
      '-movflags',
      '+faststart',
      outputVideo,
    ]

    const result = spawn(ffmpegBinaryPath, args)
    let stderrChunks: Buffer[] = []

    result.stderr.on('data', (data) => {
      stderrChunks = stderrChunks.concat(data)
    })

    result.on('close', (code) => {
      if (code !== 0) {
        const stderrOutput = Buffer.concat(stderrChunks).toString()
        return reject(new FfmpegEncodeError(`FFmpeg exited with code ${code}: ${stderrOutput}`))
      }
      return resolve()
    })

    result.on('error', (err) => {
      reject(new FfmpegEncodeError(`Failed to spawn ffmpeg: ${err.message}`))
    })
  })
}
