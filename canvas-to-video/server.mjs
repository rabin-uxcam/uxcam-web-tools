#!/usr/bin/env node

/**
 * Dev server for canvas-to-video player.
 *
 * - Serves player.html at GET /
 * - Serves output MP4s at GET /output/*
 * - GET  /strategies → list all registered conversion strategies
 * - POST /convert    → convert a session with a specific strategy
 * - POST /benchmark  → convert a session with ALL strategies for comparison
 * - POST /benchmark-bin → benchmark bin-processor optimization variants
 * - GET  /minio/*    → proxies to MinIO (avoids browser CORS issues)
 *
 * Usage:
 *   node server.mjs                         # default port 5505
 *   PORT=8080 node server.mjs               # custom port
 */

import { createServer } from 'node:http'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	createS3Client,
	listBatchFiles,
	downloadObject,
	getStrategy,
	getAllStrategies,
} from './index.mjs'
import { processBin } from './bin-processor.mjs'
import { runAllVariants, VARIANTS } from './bin-processor-variants.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PORT = parseInt(process.env.PORT || '5505', 10)
const OUTPUT_DIR = resolve(__dirname, 'output')

const MIME_TYPES = {
	'.html': 'text/html',
	'.js': 'application/javascript',
	'.mjs': 'application/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.mp4': 'video/mp4',
	'.png': 'image/png',
	'.webp': 'image/webp',
}

// ─── Response helpers ───────────────────────────────────────────────────────

function sendJson(res, statusCode, data) {
	res.writeHead(statusCode, { 'Content-Type': 'application/json' })
	res.end(JSON.stringify(data))
}

function sendFile(res, filePath) {
	if (!existsSync(filePath)) {
		res.writeHead(404)
		res.end('Not found')
		return
	}
	const mime = MIME_TYPES[extname(filePath)] || 'application/octet-stream'
	const content = readFileSync(filePath)
	res.writeHead(200, {
		'Content-Type': mime,
		'Content-Length': content.length,
		'Accept-Ranges': 'bytes',
	})
	res.end(content)
}

// ─── Strategy ID normalization ──────────────────────────────────────────────

function normalizeStrategyId(mode) {
	if (mode === 'cfr') return 'cfr-v1'
	if (mode === 'vfr') return 'vfr-v1'
	if (mode === 'vfr-v2') return 'vfr-v2'
	if (mode === 'vfr-v3') return 'vfr-v3'
	return mode
}

// ─── Shared: download batch files for a session ─────────────────────────────

async function downloadBatchFiles(params) {
	const s3Opts = {
		endpoint: params.minioUrl || 'http://localhost:9000',
		accessKey: params.accessKey || 'minioadmin',
		secretKey: params.secretKey || 'minioadmin',
	}
	const bucketName = params.bucket || 'uxcam-sessions'
	const canvasPrefix = params.prefix || 'sessions/canvas/'

	const s3 = createS3Client(s3Opts)
	const sessionPrefix = `${canvasPrefix}${params.sessionId}/`
	const objects = await listBatchFiles(s3, sessionPrefix, { bucket: bucketName })

	if (objects.length === 0) return null

	console.log(`[server] Downloading ${objects.length} batch file(s)...`)
	const batchBuffers = []
	for (const obj of objects) {
		const buffer = await downloadObject(s3, obj.Key, { bucket: bucketName })
		batchBuffers.push({ name: basename(obj.Key), buffer })
	}
	return batchBuffers
}

// ─── GET /strategies ────────────────────────────────────────────────────────

function handleListStrategies(_req, res) {
	const strategies = getAllStrategies().map((s) => ({
		id: s.id,
		name: s.name,
		description: s.description,
	}))
	sendJson(res, 200, { strategies })
}

// ─── POST /convert ──────────────────────────────────────────────────────────

async function handleConvert(req, res) {
	let body = ''
	for await (const chunk of req) body += chunk

	let params
	try {
		params = JSON.parse(body)
	} catch {
		return sendJson(res, 400, { error: 'Invalid JSON body' })
	}

	const { sessionId, mode = 'vfr-v3' } = params
	if (!sessionId) {
		return sendJson(res, 400, { error: 'sessionId is required' })
	}

	const strategyId = normalizeStrategyId(mode)
	const strategy = getStrategy(strategyId)
	if (!strategy) {
		const available = getAllStrategies().map((s) => s.id).join(', ')
		return sendJson(res, 400, { error: `Unknown strategy: ${mode}. Available: ${available}` })
	}

	console.log(`[convert] Session: ${sessionId}, Strategy: ${strategy.name}`)

	try {
		const batchBuffers = await downloadBatchFiles(params)
		if (!batchBuffers) {
			return sendJson(res, 404, { error: 'No batch files found for this session' })
		}

		const startMs = Date.now()
		const result = await strategy.convert(batchBuffers, sessionId, { outputDir: OUTPUT_DIR })
		const encodingTimeMs = Date.now() - startMs

		if (!result) {
			return sendJson(res, 500, { error: 'Conversion failed' })
		}

		const videoUrl = `/output/${sessionId}/${sessionId}.mp4`
		console.log(`[convert] Done → ${videoUrl} (${encodingTimeMs}ms)`)
		sendJson(res, 200, {
			strategy: strategy.id,
			strategyName: strategy.name,
			videoUrl,
			encodingTimeMs,
			...result,
		})
	} catch (err) {
		console.error(`[convert] Error:`, err)
		sendJson(res, 500, { error: err.message })
	}
}

// ─── POST /benchmark ────────────────────────────────────────────────────────

async function handleBenchmark(req, res) {
	let body = ''
	for await (const chunk of req) body += chunk

	let params
	try {
		params = JSON.parse(body)
	} catch {
		return sendJson(res, 400, { error: 'Invalid JSON body' })
	}

	const { sessionId } = params
	if (!sessionId) {
		return sendJson(res, 400, { error: 'sessionId is required' })
	}

	console.log(`[benchmark] Session: ${sessionId}`)

	try {
		const batchBuffers = await downloadBatchFiles(params)
		if (!batchBuffers) {
			return sendJson(res, 404, { error: 'No batch files found for this session' })
		}

		console.log(`[benchmark] Running all strategies...`)

		const strategies = getAllStrategies()
		const settled = await Promise.allSettled(
			strategies.map(async (strategy) => {
				const benchDir = join(OUTPUT_DIR, `${sessionId}-bench`)
				const sessionLabel = `${sessionId}--${strategy.id}`
				const startMs = Date.now()

				const result = await strategy.convert(batchBuffers, sessionLabel, { outputDir: benchDir })
				const encodingTimeMs = Date.now() - startMs

				if (!result) {
					return {
						strategy: strategy.id,
						name: strategy.name,
						description: strategy.description,
						error: 'Conversion failed',
						encodingTimeMs,
					}
				}

				return {
					strategy: strategy.id,
					name: strategy.name,
					description: strategy.description,
					videoUrl: `/output/${sessionId}-bench/${sessionLabel}/${sessionLabel}.mp4`,
					encodingTimeMs,
					frameCount: result.frameCount,
					videoFrameCount: result.videoFrameCount,
					videoSizeBytes: result.videoSizeBytes,
				}
			})
		)

		const results = settled.map((r) =>
			r.status === 'fulfilled'
				? r.value
				: { error: r.reason?.message || 'Unknown error' }
		)

		console.log(`[benchmark] Complete — ${results.length} strategies`)
		sendJson(res, 200, { sessionId, results })
	} catch (err) {
		console.error('[benchmark] Error:', err)
		sendJson(res, 500, { error: err.message })
	}
}

// ─── POST /convert-bin — bin-processor.ts conversion logic ───────────────────

async function handleConvertBin(req, res) {
	let body = ''
	for await (const chunk of req) body += chunk

	let params
	try {
		params = JSON.parse(body)
	} catch {
		return sendJson(res, 400, { error: 'Invalid JSON body' })
	}

	const { sessionId } = params
	if (!sessionId) {
		return sendJson(res, 400, { error: 'sessionId is required' })
	}

	console.log(`[convert-bin] Session: ${sessionId}`)

	try {
		const batchBuffers = await downloadBatchFiles(params)
		if (!batchBuffers) {
			return sendJson(res, 404, { error: 'No batch files found for this session' })
		}

		const startMs = Date.now()
		const result = await processBin(batchBuffers, sessionId, OUTPUT_DIR)
		const encodingTimeMs = Date.now() - startMs

		if (!result) {
			return sendJson(res, 500, { error: 'No frames found or conversion failed' })
		}

		const videoUrl = `/output/${sessionId}-bin/${sessionId}.mp4`
		console.log(`[convert-bin] Done → ${videoUrl} (${encodingTimeMs}ms)`)

		sendJson(res, 200, {
			videoUrl,
			encodingTimeMs,
			frameCount: result.frameCount,
			videoSizeBytes: result.videoSizeBytes,
			dimensions: result.dimensions,
		})
	} catch (err) {
		console.error('[convert-bin] Error:', err)
		sendJson(res, 500, { error: err.message })
	}
}

// ─── POST /benchmark-bin — bin-processor optimization benchmark ─────────────

async function handleBenchmarkBin(req, res) {
	let body = ''
	for await (const chunk of req) body += chunk

	let params
	try {
		params = JSON.parse(body)
	} catch {
		return sendJson(res, 400, { error: 'Invalid JSON body' })
	}

	const { sessionId } = params
	if (!sessionId) {
		return sendJson(res, 400, { error: 'sessionId is required' })
	}

	console.log(`[benchmark-bin] Session: ${sessionId}`)

	try {
		const batchBuffers = await downloadBatchFiles(params)
		if (!batchBuffers) {
			return sendJson(res, 404, { error: 'No batch files found for this session' })
		}

		const totalBinSize = batchBuffers.reduce((sum, b) => sum + b.buffer.length, 0)
		console.log(`[benchmark-bin] Downloaded ${batchBuffers.length} bins (${(totalBinSize / 1024 / 1024).toFixed(2)} MB total)`)
		console.log(`[benchmark-bin] Running ${VARIANTS.length} variants sequentially...`)

		const results = await runAllVariants(batchBuffers, sessionId, OUTPUT_DIR)

		console.log(`[benchmark-bin] Complete — ${results.length} variants`)
		sendJson(res, 200, {
			sessionId,
			totalBins: batchBuffers.length,
			totalBinSizeBytes: totalBinSize,
			variants: VARIANTS.map((v) => ({ id: v.id, name: v.name, description: v.description })),
			results,
		})
	} catch (err) {
		console.error('[benchmark-bin] Error:', err)
		sendJson(res, 500, { error: err.message })
	}
}

// ─── GET /benchmark-bin/variants — list available variants ─────────────────

function handleListVariants(_req, res) {
	sendJson(res, 200, {
		variants: VARIANTS.map((v) => ({ id: v.id, name: v.name, description: v.description })),
	})
}

// ─── GET /minio/* — proxy to MinIO ─────────────────────────────────────────

async function handleMinioProxy(req, res) {
	const url = new URL(req.url, `http://localhost:${PORT}`)
	const stripped = url.pathname.replace(/^\/minio\//, '')
	const slashIdx = stripped.indexOf('/')
	if (slashIdx === -1) {
		res.writeHead(400)
		res.end('Invalid minio proxy path')
		return
	}
	const minioHost = stripped.substring(0, slashIdx)
	const restPath = stripped.substring(slashIdx)
	const targetUrl = `http://${minioHost}${restPath}${url.search}`

	try {
		const resp = await fetch(targetUrl)
		res.writeHead(resp.status, {
			'Content-Type': resp.headers.get('content-type') || 'application/octet-stream',
			'Access-Control-Allow-Origin': '*',
		})
		const buf = Buffer.from(await resp.arrayBuffer())
		res.end(buf)
	} catch (err) {
		res.writeHead(502)
		res.end(`Proxy error: ${err.message}`)
	}
}

// ─── Server ─────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*')
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

	if (req.method === 'OPTIONS') {
		res.writeHead(204)
		res.end()
		return
	}

	const url = new URL(req.url, `http://localhost:${PORT}`)

	try {
		// Serve player.html at root
		if (url.pathname === '/' || url.pathname === '/player.html') {
			return sendFile(res, join(__dirname, 'player.html'))
		}

		// GET /strategies
		if (req.method === 'GET' && url.pathname === '/strategies') {
			return handleListStrategies(req, res)
		}

		// POST /convert
		if (req.method === 'POST' && url.pathname === '/convert') {
			return await handleConvert(req, res)
		}

		// POST /benchmark
		if (req.method === 'POST' && url.pathname === '/benchmark') {
			return await handleBenchmark(req, res)
		}

		// POST /convert-bin — bin-processor.ts logic
		if (req.method === 'POST' && url.pathname === '/convert-bin') {
			return await handleConvertBin(req, res)
		}

		// POST /benchmark-bin — bin-processor optimization benchmark
		if (req.method === 'POST' && url.pathname === '/benchmark-bin') {
			return await handleBenchmarkBin(req, res)
		}

		// GET /benchmark-bin/variants — list available variants
		if (req.method === 'GET' && url.pathname === '/benchmark-bin/variants') {
			return handleListVariants(req, res)
		}

		// GET /minio/* — proxy to MinIO
		if (url.pathname.startsWith('/minio/')) {
			return await handleMinioProxy(req, res)
		}

		// Serve static files and directory listings from output/
		if (url.pathname === '/output' || url.pathname.startsWith('/output/')) {
			const relPath = url.pathname.replace(/^\/output\/?/, '')
			const filePath = join(OUTPUT_DIR, relPath)

			if (existsSync(filePath) && statSync(filePath).isDirectory()) {
				const entries = readdirSync(filePath).map((name) => {
					const entryPath = join(filePath, name)
					const stat = statSync(entryPath)
					return {
						name,
						type: stat.isDirectory() ? 'directory' : 'file',
						size: stat.isFile() ? stat.size : undefined,
						modified: stat.mtime.toISOString(),
					}
				})
				return sendJson(res, 200, { path: url.pathname, entries })
			}

			// Range request support for video seeking
			const range = req.headers.range
			if (range && extname(filePath) === '.mp4' && existsSync(filePath)) {
				const { createReadStream } = await import('node:fs')
				const stat = statSync(filePath)
				const parts = range.replace(/bytes=/, '').split('-')
				const start = parseInt(parts[0], 10)
				const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
				const chunkSize = end - start + 1
				res.writeHead(206, {
					'Content-Range': `bytes ${start}-${end}/${stat.size}`,
					'Accept-Ranges': 'bytes',
					'Content-Length': chunkSize,
					'Content-Type': 'video/mp4',
				})
				createReadStream(filePath, { start, end }).pipe(res)
				return
			}
			return sendFile(res, filePath)
		}

		res.writeHead(404)
		res.end('Not found')
	} catch (err) {
		console.error('Request error:', err)
		res.writeHead(500)
		res.end('Internal server error')
	}
})

server.listen(PORT, () => {
	console.log(`Canvas-to-Video Player Server`)
	console.log(`  Player:     http://localhost:${PORT}`)
	console.log(`  Strategies: GET  http://localhost:${PORT}/strategies`)
	console.log(`  Convert:    POST http://localhost:${PORT}/convert`)
	console.log(`  Benchmark:  POST http://localhost:${PORT}/benchmark`)
	console.log(`  Bin-proc:   POST http://localhost:${PORT}/convert-bin`)
	console.log(`  Bench-bin:  POST http://localhost:${PORT}/benchmark-bin`)
	console.log(`  Variants:   GET  http://localhost:${PORT}/benchmark-bin/variants`)
	console.log(`  MinIO proxy: http://localhost:${PORT}/minio/<host>/<path>`)
	console.log()
})
