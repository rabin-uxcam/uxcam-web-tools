/** Parse a single canvas batch buffer (already gunzipped) */
export function parseBatch(buffer) {
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
	const metaLen = view.getUint32(0, false) // big-endian
	const metaJson = new TextDecoder().decode(buffer.subarray(4, 4 + metaLen))
	const meta = JSON.parse(metaJson)
	const dataStart = 4 + metaLen

	const frames = meta.frames.map((f) => ({
		...f,
		data: buffer.subarray(dataStart + f.offset, dataStart + f.offset + f.size),
	}))

	return { batchIndex: meta.batchIndex, frames }
}
