import { spawn } from 'child_process'
import { writeFileSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { gunzipSync } from 'zlib'
import sharp from 'sharp'

import { createLogger } from '../lib/logger'
import { deleteFolder } from '../lib/delete-folder'
import { FfmpegEncodeError } from '../lib/errors'
import { S3Service } from './s3-service'
import { MongoId } from '../models/mongo'
import { constructS3PathForVideoFile, getTemporaryDownloadFolderName } from '../models/s3'

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

export function BinProcessingService(s3Service: S3Service, ffmpegBinaryPath: string, tempDownloadFolder: string): BinProcessingService {
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
 *   JSON: [{ t, sz, w, h }, ...]
 *
 * The .bin files stored in S3 may be gzipped at the outer level,
 * so we attempt outer decompression first before parsing the inner binary format.
 */
function parseBatchBuffers(batchBuffers: BatchBuffer[]): ParsedFrame[] {
  const log = createLogger('parseBatchBuffers')
  const allFrames: ParsedFrame[] = []

  for (const { name, buffer } of batchBuffers) {
    log.info({ name, bufferSize: buffer.length }, 'Processing bin file')

    try {
      // Outer decompression — S3-stored .bin files may be gzipped at the outer level
      const raw = decompressBuffer(buffer)

      const gzippedJsonLen = raw.readUInt32BE(0)
      const gzippedJson = raw.subarray(4, 4 + gzippedJsonLen)
      const jsonBytes = gunzipSync(gzippedJson)
      const meta: Array<{ t: number; sz: number; w: number; h: number }> = JSON.parse(new TextDecoder().decode(jsonBytes))

      const dataStart = 4 + gzippedJsonLen
      let cursor = 0

      for (const f of meta) {
        const frameData = raw.subarray(dataStart + cursor, dataStart + cursor + f.sz)
        cursor += f.sz
        allFrames.push({ time: f.t, width: f.w, height: f.h, data: Buffer.from(frameData) })
      }

      log.info({ name, framesExtracted: meta.length }, 'Parsed batch buffer')
    } catch (err) {
      log.warn({ name, error: (err as Error).message }, 'Failed to parse batch buffer, skipping')
    }
  }

  log.info({ totalFrames: allFrames.length, totalFiles: batchBuffers.length }, 'Finished parsing all batch buffers')
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
      await sharp(allFrames[i].data)
        .resize(maxW, maxH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
        .webp({ quality: 80 })
        .toFile(framePath)
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
      '-vsync',
      'vfr',
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
