/**
 * S3/MinIO client helpers for fetching canvas batch files.
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'http://localhost:9000'
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'minioadmin'
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || 'minioadmin'
const DEFAULT_BUCKET = process.env.CANVAS_BUCKET || 'uxcam-sessions'
const DEFAULT_PREFIX = process.env.CANVAS_PREFIX || 'sessions/canvas/'

export function createS3Client(opts = {}) {
	return new S3Client({
		endpoint: opts.endpoint || MINIO_ENDPOINT,
		region: 'us-east-1',
		forcePathStyle: true,
		credentials: {
			accessKeyId: opts.accessKey || MINIO_ACCESS_KEY,
			secretAccessKey: opts.secretKey || MINIO_SECRET_KEY,
		},
	})
}

export async function listCanvasSessions(s3, opts = {}) {
	const cmd = new ListObjectsV2Command({
		Bucket: opts.bucket || DEFAULT_BUCKET,
		Prefix: opts.prefix || DEFAULT_PREFIX,
		Delimiter: '/',
	})
	const resp = await s3.send(cmd)
	return (resp.CommonPrefixes || []).map((p) => p.Prefix)
}

export async function listBatchFiles(s3, sessionPrefix, opts = {}) {
	const cmd = new ListObjectsV2Command({
		Bucket: opts.bucket || DEFAULT_BUCKET,
		Prefix: sessionPrefix,
	})
	const resp = await s3.send(cmd)
	return (resp.Contents || [])
		.filter((obj) => obj.Key.endsWith('.bin') || obj.Key.endsWith('.json.gz'))
		.sort((a, b) => a.Key.localeCompare(b.Key))
}

export async function downloadObject(s3, key, opts = {}) {
	const cmd = new GetObjectCommand({ Bucket: opts.bucket || DEFAULT_BUCKET, Key: key })
	const resp = await s3.send(cmd)
	const chunks = []
	for await (const chunk of resp.Body) {
		chunks.push(chunk)
	}
	return Buffer.concat(chunks)
}
