#!/usr/bin/env node

/**
 * docker-bench.mjs — Run bin-processor variants inside a Docker container
 *  npm run bench:docker:build  && npm run bench:docker:build && npm run bench:docker -- --session 1777213994085-bad0216f098d4fe3
 * Designed to be run inside the Dockerfile.bench container with resource limits:
 *   docker run --cpus=2 --memory=800m --memory-swap=800m bin-bench \
 *     node docker-bench.mjs --session <sessionId> [--variant <id>]
 *
 * Can also be run standalone without Docker for quick local testing.
 *
 * Environment:
 *   MINIO_ENDPOINT  - MinIO URL (default: http://host.docker.internal:9000)
 *   MINIO_ACCESS_KEY - (default: minioadmin)
 *   MINIO_SECRET_KEY - (default: minioadmin)
 *   CANVAS_BUCKET    - (default: uxcam-sessions)
 *   CANVAS_PREFIX    - (default: sessions/canvas/)
 */

import { basename } from 'node:path'
import { createS3Client, listBatchFiles, downloadObject } from './s3-helpers.mjs'
import { runVariant, runAllVariants, VARIANTS } from './bin-processor-variants.mjs'

const OUTPUT_DIR = './output'

function getArg(flag) {
  const idx = process.argv.indexOf(flag)
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null
}

function printUsage() {
  console.log(`
Usage: node docker-bench.mjs --session <sessionId> [--variant <id>]

Options:
  --session   Session ID to process (required)
  --variant   Specific variant to run (omit to run all)
  --help      Show this help

Available variants:
${VARIANTS.map(v => `  ${v.id.padEnd(16)} ${v.description}`).join('\n')}

Docker usage (with resource limits):
  docker build -f Dockerfile.bench -t bin-bench .
  docker run --rm --cpus=2 --memory=800m --memory-swap=800m \\
    -v $(pwd)/output:/app/output \\
    -e MINIO_ENDPOINT=http://host.docker.internal:9000 \\
    bin-bench node docker-bench.mjs --session <sessionId>
`)
}

async function downloadBatchFiles(sessionId) {
  const endpoint = process.env.MINIO_ENDPOINT || 'http://host.docker.internal:9000'
  const bucket = process.env.CANVAS_BUCKET || 'uxcam-sessions'
  const prefix = process.env.CANVAS_PREFIX || 'sessions/canvas/'

  console.log(`Connecting to MinIO: ${endpoint}`)
  console.log(`Bucket: ${bucket}, Prefix: ${prefix}${sessionId}/`)

  const s3 = createS3Client({ endpoint })
  const sessionPrefix = `${prefix}${sessionId}/`
  const objects = await listBatchFiles(s3, sessionPrefix, { bucket })

  if (objects.length === 0) {
    console.error(`No batch files found for session: ${sessionId}`)
    process.exit(1)
  }

  console.log(`Downloading ${objects.length} batch file(s)...`)
  const batchBuffers = []
  for (const obj of objects) {
    const buffer = await downloadObject(s3, obj.Key, { bucket })
    batchBuffers.push({ name: basename(obj.Key), buffer })
  }

  const totalSize = batchBuffers.reduce((sum, b) => sum + b.buffer.length, 0)
  console.log(`Downloaded ${batchBuffers.length} bins (${(totalSize / 1024 / 1024).toFixed(2)} MB)\n`)
  return batchBuffers
}

function printResults(results) {
  console.log('\n' + '='.repeat(90))
  console.log('BENCHMARK RESULTS')
  console.log('='.repeat(90))

  // Header
  const hdr = [
    'Variant'.padEnd(22),
    'Time'.padStart(8),
    'Node RSS'.padStart(10),
    'FFmpeg RSS'.padStart(12),
    'Total Peak'.padStart(12),
    'Video Size'.padStart(12),
    'Status'.padStart(10),
  ].join(' | ')
  console.log(hdr)
  console.log('-'.repeat(90))

  for (const r of results) {
    if (r.error) {
      console.log(`${(r.name || r.variantId).padEnd(22)} | ${'FAILED'.padStart(8)} | ${r.error}`)
      continue
    }

    const m = r.metrics
    const totalPeak = parseFloat(m.estimatedTotalPeakMB)
    const status = totalPeak > 800 ? 'OOM RISK' : 'OK'

    const row = [
      (r.name || r.variantId).padEnd(22),
      `${(m.encodingTimeMs / 1000).toFixed(1)}s`.padStart(8),
      `${m.peakNodeRssMB} MB`.padStart(10),
      `${m.peakFfmpegRssMB} MB`.padStart(12),
      `${m.estimatedTotalPeakMB} MB`.padStart(12),
      `${(m.videoSizeBytes / 1024 / 1024).toFixed(2)} MB`.padStart(12),
      status.padStart(10),
    ].join(' | ')
    console.log(row)
  }

  console.log('='.repeat(90))

  // Summary
  const successful = results.filter(r => r.metrics)
  if (successful.length > 0) {
    const fastest = successful.reduce((a, b) => a.metrics.encodingTimeMs < b.metrics.encodingTimeMs ? a : b)
    const lowestMem = successful.reduce((a, b) =>
      parseFloat(a.metrics.estimatedTotalPeakMB) < parseFloat(b.metrics.estimatedTotalPeakMB) ? a : b
    )
    const smallestFile = successful.reduce((a, b) => a.metrics.videoSizeBytes < b.metrics.videoSizeBytes ? a : b)

    console.log(`\nFastest:       ${fastest.name} (${(fastest.metrics.encodingTimeMs / 1000).toFixed(1)}s)`)
    console.log(`Lowest memory: ${lowestMem.name} (${lowestMem.metrics.estimatedTotalPeakMB} MB)`)
    console.log(`Smallest file: ${smallestFile.name} (${(smallestFile.metrics.videoSizeBytes / 1024 / 1024).toFixed(2)} MB)`)
  }
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage()
    process.exit(0)
  }

  const sessionId = getArg('--session')
  if (!sessionId) {
    console.error('Error: --session is required')
    printUsage()
    process.exit(1)
  }

  const variantId = getArg('--variant')
  if (variantId && !VARIANTS.find(v => v.id === variantId)) {
    console.error(`Error: Unknown variant "${variantId}"`)
    console.error(`Available: ${VARIANTS.map(v => v.id).join(', ')}`)
    process.exit(1)
  }

  const batchBuffers = await downloadBatchFiles(sessionId)

  if (variantId) {
    console.log(`Running single variant: ${variantId}\n`)
    const result = await runVariant(variantId, batchBuffers, sessionId, OUTPUT_DIR)
    printResults([result])
  } else {
    console.log(`Running all ${VARIANTS.length} variants...\n`)
    const results = await runAllVariants(batchBuffers, sessionId, OUTPUT_DIR)
    printResults(results)
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
