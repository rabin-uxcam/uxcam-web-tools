#!/usr/bin/env node

/**
 * Dev server for canvas-to-video player.
 *
 * - Serves player.html at GET /
 * - Serves output MP4s at GET /output/*
 * - POST /convert  → runs the same ffmpeg pipeline as index.mjs
 * - GET  /minio/*  → proxies to MinIO (avoids browser CORS issues)
 *
 * Usage:
 *   node server.mjs                         # default port 3000
 *   PORT=8080 node server.mjs               # custom port
 */

import { createServer } from 'node:http'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	createS3Client,
	listBatchFiles,
	downloadObject,
	processSession,
	processSessionVFR,
} from './index.mjs'

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

async function handleConvert(req, res) {
	let body = ''
	for await (const chunk of req) body += chunk

	let params
	try {
		params = JSON.parse(body)
	} catch {
		return sendJson(res, 400, { error: 'Invalid JSON body' })
	}

	const { sessionId, minioUrl, bucket, prefix, mode = 'vfr' } = params
	if (!sessionId) {
		return sendJson(res, 400, { error: 'sessionId is required' })
	}

	// mode: 'cfr' (default, constant frame rate — duplicates frames to fill gaps)
	//        'vfr' (variable frame rate — uses concat demuxer with per-frame durations)
	const useVFR = mode === 'vfr'

	const s3Opts = {
		endpoint: minioUrl || 'http://localhost:9000',
		accessKey: params.accessKey || 'minioadmin',
		secretKey: params.secretKey || 'minioadmin',
	}
	const bucketName = bucket || 'uxcam-sessions'
	const canvasPrefix = prefix || 'sessions/canvas/'

	console.log(`[convert] Session: ${sessionId}, MinIO: ${s3Opts.endpoint}, Mode: ${useVFR ? 'VFR' : 'CFR'}`)

	try {
		const s3 = createS3Client(s3Opts)

		// List batch files for this session
		const sessionPrefix = `${canvasPrefix}${sessionId}/`
		const objects = await listBatchFiles(s3, sessionPrefix, { bucket: bucketName })

		if (objects.length === 0) {
			return sendJson(res, 404, { error: 'No batch files found for this session' })
		}

		console.log(`[convert] Downloading ${objects.length} batch file(s)...`)

		const { basename } = await import('node:path')
		const batchBuffers = []
		for (const obj of objects) {
			const buffer = await downloadObject(s3, obj.Key, { bucket: bucketName })
			batchBuffers.push({ name: basename(obj.Key), buffer })
		}

		const converter = useVFR ? processSessionVFR : processSession
		console.log(`[convert] Running ffmpeg conversion (${useVFR ? 'VFR' : 'CFR'})...`)
		const result = await converter(batchBuffers, sessionId, { outputDir: OUTPUT_DIR })

		if (!result) {
			return sendJson(res, 500, { error: 'ffmpeg conversion failed' })
		}

		const videoUrl = `/output/${sessionId}/${sessionId}.mp4`
		console.log(`[convert] Done → ${videoUrl}`)
		sendJson(res, 200, { videoUrl, ...result })
	} catch (err) {
		console.error(`[convert] Error:`, err)
		sendJson(res, 500, { error: err.message })
	}
}

async function handleMinioProxy(req, res) {
	// GET /minio/<minioHost>/<path...>
	// e.g. /minio/localhost:9000/uxcam-sessions?list-type=2&prefix=sessions/canvas/
	const url = new URL(req.url, `http://localhost:${PORT}`)
	const stripped = url.pathname.replace(/^\/minio\//, '')
	// First segment is the host (possibly with port)
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

const server = createServer(async (req, res) => {
	// CORS headers for all responses
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

		// POST /convert
		if (req.method === 'POST' && url.pathname === '/convert') {
			return await handleConvert(req, res)
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
				// Directory listing as JSON
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
	console.log(`  Player:  http://localhost:${PORT}`)
	console.log(`  Convert: POST http://localhost:${PORT}/convert`)
	console.log(`  MinIO proxy: http://localhost:${PORT}/minio/<host>/<path>`)
	console.log()
})
