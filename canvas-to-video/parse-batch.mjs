import { gunzipSync } from 'node:zlib'

/**
 * Parse a single canvas batch buffer (already gunzipped at the outer level).
 *
 * Supports three formats:
 *
 *   1. V3 (current): Gzipped JSON array with inline base64 data URLs
 *      [{ t, w, h, d: "data:image/webp;base64,..." }, ...]
 *      (outer gunzip by caller produces JSON starting with '[')
 *
 *   2. V2: [4-byte gzipped JSON len][gzipped JSON][raw WebP blobs]
 *      JSON: [{ t, sz, w, h }, ...] — metadata per frame
 *      Blobs are concatenated in order, unpacked sequentially using `sz`.
 *
 *   3. JSON (legacy): JSON array of change objects with inline base64 data URLs
 *      [{seq, time, type:'CANVAS_FRAME_EXPERIMENTAL', target, data:'data:image/webp;base64,...'}, ...]
 *
 *   4. V1 (legacy): [4-byte meta len][raw JSON][concatenated frame blobs]
 *      JSON has { batchIndex, frames: [{ time, width, height, offset, size }] }
 *
 *   Note: V3 and legacy JSON both route through parseBatchJSON. V3 uses t/d/w/h
 *   short fields, legacy uses time/data long fields — both are supported.
 */
export function parseBatch(buffer) {
	// JSON format starts with '[' (0x5B)
	if (buffer[0] === 0x5B) {
		return parseBatchJSON(buffer)
	}
	// Binary format — detect v2 (gzipped JSON header) vs v1 (raw JSON header)
	return parseBatchBinaryAuto(buffer)
}

/**
 * Auto-detect v2 (gzipped JSON metadata + raw blobs) vs v1 (raw JSON + offset-based blobs).
 *
 * Heuristic: read the 4-byte header length, then check if the bytes at offset 4
 * start with gzip magic (0x1F 0x8B). If so, it's v2. Otherwise v1.
 */
function parseBatchBinaryAuto(buffer) {
	const headerLen = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0, false)

	// Check for gzip magic bytes at offset 4
	if (buffer.length >= 6 && buffer[4] === 0x1F && buffer[5] === 0x8B) {
		return parseBatchBinaryV2(buffer, headerLen)
	}

	return parseBatchBinaryV1(buffer, headerLen)
}

/**
 * V2: [4-byte gzipped JSON len][gzipped JSON metadata][raw WebP blobs]
 * JSON: [{ t, sz, w, h }, ...]
 * Sequential cursor-based unpacking using `sz`.
 */
function parseBatchBinaryV2(buffer, gzippedJsonLen) {
	const gzippedJson = buffer.subarray(4, 4 + gzippedJsonLen)
	const jsonBytes = gunzipSync(gzippedJson)
	const meta = JSON.parse(new TextDecoder().decode(jsonBytes))

	const dataStart = 4 + gzippedJsonLen
	let cursor = 0

	const frames = meta.map((f) => {
		const frameData = buffer.subarray(dataStart + cursor, dataStart + cursor + f.sz)
		cursor += f.sz
		return {
			time: f.t,
			width: f.w,
			height: f.h,
			data: Buffer.from(frameData),
		}
	})

	return { batchIndex: 0, frames }
}

/**
 * V1 (legacy): [4-byte meta len][raw JSON]{batchIndex, frames:[{time,width,height,offset,size}]}[blobs]
 */
function parseBatchBinaryV1(buffer, metaLen) {
	const metaJson = new TextDecoder().decode(buffer.subarray(4, 4 + metaLen))
	const meta = JSON.parse(metaJson)
	const dataStart = 4 + metaLen

	const frames = meta.frames.map((f) => ({
		...f,
		data: buffer.subarray(dataStart + f.offset, dataStart + f.offset + f.size),
	}))

	return { batchIndex: meta.batchIndex, frames }
}

/**
 * JSON format: array of change objects with inline base64 data URLs
 */
function parseBatchJSON(buffer) {
	const json = new TextDecoder().decode(buffer)
	const changes = JSON.parse(json)

	const frames = changes.map((change) => {
		const dataURL = change.data || change.d
		const time = change.time || change.t

		// Extract base64 from data URL: "data:image/webp;base64,AAAA..."
		const commaIdx = dataURL.indexOf(',')
		const base64 = dataURL.substring(commaIdx + 1)

		// Decode base64 to binary
		const binaryStr = atob(base64)
		const bytes = new Uint8Array(binaryStr.length)
		for (let i = 0; i < binaryStr.length; i++) {
			bytes[i] = binaryStr.charCodeAt(i)
		}

		return {
			time,
			width: change.w || change.width || 0,
			height: change.h || change.height || 0,
			data: Buffer.from(bytes),
		}
	})

	return { batchIndex: 0, frames }
}
