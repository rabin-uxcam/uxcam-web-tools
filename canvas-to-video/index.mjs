#!/usr/bin/env node

/**
 * Canvas Batch → Video Converter
 *
 * Thin orchestration hub that imports strategies and re-exports helpers.
 * Each conversion strategy is in its own strategy-*.mjs file.
 *
 * Usage:
 *   node index.mjs                           # interactive — uses defaults
 *   node index.mjs --bucket uxcam-sessions --prefix sessions/canvas/
 *   node index.mjs --dir ./local-batches     # read from local directory instead of S3
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { execSync } from 'node:child_process'

// ─── S3 helpers (extracted) ─────────────────────────────────────────────────
export { createS3Client, listCanvasSessions, listBatchFiles, downloadObject } from './s3-helpers.mjs'

// ─── Import strategies (self-register on import) ───────────────────────────
import './strategy-cfr-v1.mjs'
import './strategy-vfr-v1.mjs'
import './strategy-vfr-v2.mjs'
import './strategy-vfr-v3.mjs'
import './strategy-vfr-v4.mjs'

// ─── Registry re-exports ───────────────────────────────────────────────────
export { getStrategy, getAllStrategies, getStrategyIds } from './strategy-registry.mjs'

// ─── Backward-compatible named exports ─────────────────────────────────────
import { getStrategy } from './strategy-registry.mjs'
export const processSession = (b, s, o) => getStrategy('cfr-v1').convert(b, s, o)
export const processSessionVFR = (b, s, o) => getStrategy('vfr-v1').convert(b, s, o)

// ─── Pipeline re-exports (used by validate-sync) ───────────────────────────
export { ensureDir } from './pipeline.mjs'

// ─── CLI helpers ────────────────────────────────────────────────────────────

function getArg(flag) {
	const idx = process.argv.indexOf(flag)
	return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null
}

function listLocalBatchFiles(dir) {
	return readdirSync(dir)
		.filter((f) => f.endsWith('.bin') || f.endsWith('.json.gz'))
		.sort()
		.map((f) => join(dir, f))
}

// ─── CLI entry ──────────────────────────────────────────────────────────────

async function main() {
	const BUCKET = getArg('--bucket') || process.env.CANVAS_BUCKET || 'uxcam-sessions'
	const PREFIX = getArg('--prefix') || process.env.CANVAS_PREFIX || 'sessions/canvas/'
	const LOCAL_DIR = getArg('--dir') || null
	const OUTPUT_DIR = getArg('--output') || './output'
	const FPS_OVERRIDE = getArg('--fps') ? parseInt(getArg('--fps'), 10) : null
	const MODE = getArg('--mode') || 'vfr-v1'

	const { ensureDir } = await import('./pipeline.mjs')

	console.log('Canvas Batch → Video Converter')
	console.log('================================')

	ensureDir(OUTPUT_DIR)

	// Check ffmpeg
	try {
		execSync('ffmpeg -version', { stdio: 'pipe' })
	} catch {
		console.error('Error: ffmpeg is not installed. Install it with: brew install ffmpeg')
		process.exit(1)
	}

	const strategy = getStrategy(MODE)
	if (!strategy) {
		const { getAllStrategies } = await import('./strategy-registry.mjs')
		console.error(`Unknown mode: ${MODE}. Available: ${getAllStrategies().map(s => s.id).join(', ')}`)
		process.exit(1)
	}

	console.log(`Strategy: ${strategy.name}`)

	if (LOCAL_DIR) {
		console.log(`\nReading from local directory: ${LOCAL_DIR}`)
		const files = listLocalBatchFiles(LOCAL_DIR)
		if (files.length === 0) {
			console.log('No .bin files found')
			process.exit(1)
		}
		console.log(`Found ${files.length} batch file(s)\n`)

		const batchBuffers = files.map((f) => ({
			name: basename(f),
			buffer: readFileSync(f),
		}))

		const sessionName = basename(LOCAL_DIR) || 'local-session'
		const opts = { outputDir: OUTPUT_DIR }
		if (FPS_OVERRIDE) opts.fps = FPS_OVERRIDE
		await strategy.convert(batchBuffers, sessionName, opts)
	} else {
		const { createS3Client, listCanvasSessions, listBatchFiles, downloadObject } = await import('./s3-helpers.mjs')
		const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'http://localhost:9000'

		console.log(`\nConnecting to MinIO: ${MINIO_ENDPOINT}`)
		console.log(`Bucket: ${BUCKET}, Prefix: ${PREFIX}\n`)

		const s3 = createS3Client()

		let sessions
		try {
			sessions = await listCanvasSessions(s3, { bucket: BUCKET, prefix: PREFIX })
		} catch (err) {
			console.error('Failed to connect to MinIO:', err.message)
			console.log('\nMake sure MinIO is running and accessible at', MINIO_ENDPOINT)
			process.exit(1)
		}

		if (sessions.length === 0) {
			console.log('No canvas sessions found in bucket')
			process.exit(0)
		}

		console.log(`Found ${sessions.length} canvas session(s):\n`)

		for (const sessionPrefix of sessions) {
			const sessionName = sessionPrefix.replace(PREFIX, '').replace(/\/$/, '')
			console.log(`Processing session: ${sessionName}`)

			const objects = await listBatchFiles(s3, sessionPrefix, { bucket: BUCKET })
			if (objects.length === 0) {
				console.log('  No batch files found — skipping')
				continue
			}

			console.log(`  Downloading ${objects.length} batch file(s)...`)

			const batchBuffers = []
			for (const obj of objects) {
				const buffer = await downloadObject(s3, obj.Key, { bucket: BUCKET })
				batchBuffers.push({ name: basename(obj.Key), buffer })
			}

			const opts = { outputDir: OUTPUT_DIR }
			if (FPS_OVERRIDE) opts.fps = FPS_OVERRIDE
			await strategy.convert(batchBuffers, sessionName, opts)
			console.log()
		}
	}

	console.log('\nDone!')
}

// Only run CLI when executed directly
import { fileURLToPath as _fup } from 'node:url'
import { resolve as _resolve } from 'node:path'
if (process.argv[1] && _resolve(process.argv[1]) === _fup(import.meta.url)) {
	main().catch((err) => {
		console.error('Fatal error:', err)
		process.exit(1)
	})
}
