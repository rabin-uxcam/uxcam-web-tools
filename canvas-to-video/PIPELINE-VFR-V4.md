# Canvas-to-Video Pipeline — VFR-V4 (AV1)

Reference doc for reimplementing the core pipeline in an SQS-based processing service.
All temporary files use `/tmp` (ephemeral, auto-cleaned on Lambda/ECS/Fargate).

---

## End-to-End Flow

```
S3 batch files → Download → Decompress → Parse → Sort → /tmp frames → concat.txt → FFmpeg → MP4 → Upload to S3 → Cleanup /tmp
```

---

## 1. INPUT: Batch Buffers from S3

Each recording session stores canvas snapshots as batch files in S3:

```
s3://{bucket}/sessions/canvas/{sessionId}/
  ├── batch-0000.bin
  ├── batch-0001.bin
  └── batch-0002.bin
```

Files are `.bin` (gzipped binary) or `.json.gz`. Download each into memory:

```typescript
type BatchBuffer = {
  name: string   // "batch-0000.bin"
  buffer: Buffer  // raw S3 object bytes
}

// Download all batch files for a session
const batchBuffers: BatchBuffer[] = []
for (const obj of s3Objects) {
  const buffer = await downloadS3Object(obj.Key)
  batchBuffers.push({ name: basename(obj.Key), buffer })
}
```

**In SQS context**: SQS message contains `{ sessionId, bucket, prefix }`. Use that to list and download the batch files.

---

## 2. DECOMPRESS + PARSE: Batch → Frames

Each batch buffer goes through two layers:

### 2a. Outer decompression

```javascript
import { gunzipSync } from 'node:zlib'

function decompressBuffer(buffer) {
  try { return gunzipSync(buffer) }
  catch { return buffer } // not gzipped, use as-is
}
```

### 2b. Format auto-detection

After outer decompression, detect format by first byte(s):

| Check | Format | Parse logic |
|-------|--------|-------------|
| First byte = `0x5B` (`[`) | **V3 (current)** or **JSON legacy** | JSON array |
| Bytes 4-5 = `0x1F 0x8B` (gzip magic) | **V2 binary** | `[4B gzip-json-len][gzipped JSON meta][raw WebP blobs]` |
| Otherwise | **V1 binary (legacy)** | `[4B meta-len][raw JSON meta][offset-based blobs]` |

### V3 format (current — what your SDK produces)

Outer gunzip yields a JSON array:

```json
[
  { "t": 1500, "w": 1920, "h": 1080, "d": "data:image/webp;base64,UklGR..." },
  { "t": 1833, "w": 1920, "h": 1080, "d": "data:image/webp;base64,UklGR..." }
]
```

Parse:
```javascript
function parseBatchJSON(buffer) {
  const changes = JSON.parse(new TextDecoder().decode(buffer))

  const frames = changes.map((change) => {
    const dataURL = change.d || change.data
    const time = change.t || change.time

    // Strip "data:image/webp;base64," prefix, decode to binary
    const base64 = dataURL.substring(dataURL.indexOf(',') + 1)
    const binary = Buffer.from(base64, 'base64')

    return {
      time,
      width: change.w || change.width || 0,
      height: change.h || change.height || 0,
      data: binary, // raw WebP image bytes
    }
  })

  return { batchIndex: 0, frames }
}
```

### V2 format

```
[4 bytes: big-endian uint32 = gzipped JSON length]
[gzipped JSON: [{ t, sz, w, h }, ...]]
[raw WebP blobs concatenated sequentially]
```

Parse:
```javascript
function parseBatchBinaryV2(buffer, gzippedJsonLen) {
  const gzippedJson = buffer.subarray(4, 4 + gzippedJsonLen)
  const meta = JSON.parse(new TextDecoder().decode(gunzipSync(gzippedJson)))

  const dataStart = 4 + gzippedJsonLen
  let cursor = 0

  const frames = meta.map((f) => {
    const frameData = buffer.subarray(dataStart + cursor, dataStart + cursor + f.sz)
    cursor += f.sz
    return { time: f.t, width: f.w, height: f.h, data: Buffer.from(frameData) }
  })

  return { batchIndex: 0, frames }
}
```

### V1 format (legacy)

```
[4 bytes: big-endian uint32 = raw JSON length]
[raw JSON: { batchIndex, frames: [{ time, width, height, offset, size }] }]
[blobs at offsets]
```

### After parsing all batches

Merge all frames into one flat array, sorted by timestamp:

```javascript
const allFrames = []
for (const { name, buffer } of batchBuffers) {
  const raw = decompressBuffer(buffer)
  const batch = parseBatch(raw)
  for (const frame of batch.frames) {
    allFrames.push({
      batchIndex: batch.batchIndex,
      time: frame.time,       // ms since session start
      width: frame.width,
      height: frame.height,
      data: frame.data,        // Buffer of raw WebP bytes
    })
  }
}
allFrames.sort((a, b) => a.time - b.time)
```

**Result**: `allFrames[]` — flat, time-sorted array of `{ time, width, height, data }`.

---

## 3. RESOLVE CANVAS DIMENSIONS

Find the maximum width/height across all frames (the video canvas size):

```javascript
let maxW = 0, maxH = 0
for (const f of allFrames) {
  if (f.width > maxW) maxW = f.width
  if (f.height > maxH) maxH = f.height
}
// Codecs require even dimensions
if (maxW % 2 !== 0) maxW++
if (maxH % 2 !== 0) maxH++

const hasVaryingSizes = allFrames.some(
  f => f.width !== allFrames[0].width || f.height !== allFrames[0].height
)
```

If any frame has `width=0` or `height=0`, read dimensions from the first frame's WebP metadata using `sharp`:
```javascript
const meta = await sharp(Buffer.from(allFrames[0].data)).metadata()
// backfill missing dimensions
```

---

## 4. BUILD EFFECTIVE TIMELINE (Gap Capping)

Real timestamps can have long idle gaps (user away). Cap any gap at 10 seconds so the video doesn't have dead time:

```javascript
const MAX_GAP_MS = 10_000

const effectiveTimes = [0]
for (let i = 1; i < allFrames.length; i++) {
  const realGap = allFrames[i].time - allFrames[i - 1].time
  effectiveTimes.push(effectiveTimes[i - 1] + Math.min(realGap, MAX_GAP_MS))
}
```

Example:
```
Real times:      [0, 300, 600, 60000, 60300]   ← 59.4s idle gap
Effective times: [0, 300, 600, 10600, 10900]   ← capped to 10s
```

---

## 5. WRITE FRAMES TO /tmp

Create an isolated temp directory per session:

```javascript
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const workDir = mkdtempSync(join(tmpdir(), `canvas-${sessionId}-`))
// e.g. /tmp/canvas-abc123-Xq7kM2/
```

Write each frame as a WebP file:

```javascript
for (let i = 0; i < allFrames.length; i++) {
  const framePath = join(workDir, `src-${String(i).padStart(5, '0')}.webp`)

  if (hasVaryingSizes) {
    // Resize to uniform canvas, black letterbox
    await sharp(Buffer.from(allFrames[i].data))
      .resize(maxW, maxH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .webp({ quality: 80 })
      .toFile(framePath)
  } else {
    // Write raw WebP bytes directly
    writeFileSync(framePath, Buffer.from(allFrames[i].data))
  }
}
```

**Output**: `src-00000.webp`, `src-00001.webp`, ... in `workDir`.

---

## 6. BUILD concat.txt IN /tmp

FFmpeg's concat demuxer needs a text file listing frames and their durations.
Write this to `workDir/concat.txt`:

```javascript
const lines = ['ffconcat version 1.0']

for (let i = 0; i < allFrames.length; i++) {
  const durationSec = (i + 1 < allFrames.length)
    ? (effectiveTimes[i + 1] - effectiveTimes[i]) / 1000
    : 0.5  // hold last frame for 500ms

  lines.push(`file ${join(workDir, `src-${String(i).padStart(5, '0')}.webp`)}`)
  lines.push(`duration ${durationSec.toFixed(6)}`)
}

// FFmpeg concat demuxer requires the last file repeated without duration
lines.push(`file ${join(workDir, `src-${String(allFrames.length - 1).padStart(5, '0')}.webp`)}`)

writeFileSync(join(workDir, 'concat.txt'), lines.join('\n'), 'utf-8')
```

Example `concat.txt`:
```
ffconcat version 1.0
file /tmp/canvas-abc123-Xq7kM2/src-00000.webp
duration 0.333000
file /tmp/canvas-abc123-Xq7kM2/src-00001.webp
duration 0.300000
file /tmp/canvas-abc123-Xq7kM2/src-00002.webp
duration 0.500000
file /tmp/canvas-abc123-Xq7kM2/src-00002.webp
```

---

## 7. FFMPEG ENCODE

```javascript
import { execSync } from 'node:child_process'

const outputVideo = join(workDir, `${sessionId}.mp4`)

execSync([
  'ffmpeg', '-y',
  '-f', 'concat',
  '-safe', '0',
  '-i', join(workDir, 'concat.txt'),
  '-c:v', 'libaom-av1',       // AV1 codec — best compression for screen content
  '-pix_fmt', 'yuv420p',      // browser-compatible pixel format
  '-vsync', 'vfr',            // variable frame rate — no frame duplication
  '-crf', '32',               // quality (higher = smaller; 32 is good for screenshots)
  '-cpu-used', '6',           // speed preset (0-8; 6 = fast, acceptable quality)
  '-row-mt', '1',             // multi-threaded row encoding
  '-tiles', '2x2',            // tile parallelism
  '-movflags', '+faststart',  // move moov atom for streaming
  outputVideo,
].join(' '), { stdio: 'pipe' })
```

**Alternative codecs** (if AV1 is too slow for your server):
- Replace `-c:v libaom-av1 -crf 32 -cpu-used 6 -row-mt 1 -tiles 2x2` with:
- H.264: `-c:v libx264 -crf 23 -preset fast` (fastest, largest files)
- H.265: `-c:v libx265 -crf 28 -preset fast` (middle ground, limited browser support)

---

## 8. OUTPUT

### Video file
`{workDir}/{sessionId}.mp4` — upload this to your destination S3 bucket.

### Manifest (optional but recommended)
JSON metadata for replay synchronization:

```json
{
  "session": "abc123",
  "strategy": "vfr-v4",
  "totalBatches": 5,
  "totalFrames": 42,
  "timeSpanMs": 60000,
  "effectiveTimeSpanMs": 35000,
  "videoFps": 3,
  "videoFrameCount": 42,
  "videoSize": { "width": 1920, "height": 1080 },
  "batches": [
    {
      "file": "batch-0000.bin",
      "batchIndex": 0,
      "rawSizeBytes": 52000,
      "compressedSizeBytes": 38000,
      "frameCount": 8,
      "frames": [{ "time": 100, "width": 1920, "height": 1080, "sizeBytes": 6500 }],
      "timeRange": { "start": 100, "end": 3400, "spanMs": 3300 }
    }
  ],
  "frames": [
    {
      "index": 0,
      "batchIndex": 0,
      "time": 100,
      "effectiveTime": 0,
      "width": 1920,
      "height": 1080,
      "durationMs": 333,
      "file": "src-00000.webp"
    }
  ]
}
```

### Cleanup

After uploading to S3, delete the temp directory:

```javascript
import { rmSync } from 'node:fs'
rmSync(workDir, { recursive: true })
```

---

## 9. COMPLETE SQS WORKER SKELETON

```javascript
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { execSync } from 'node:child_process'
import sharp from 'sharp'

async function handleSQSMessage(message) {
  const { sessionId, bucket, prefix } = JSON.parse(message.Body)

  // 1. Download batches from S3
  const batchBuffers = await downloadBatches(bucket, prefix)

  // 2. Parse into frames
  const allFrames = parseAllBatches(batchBuffers)
  if (allFrames.length === 0) return

  // 3. Resolve dimensions
  const { maxW, maxH, hasVaryingSizes } = await resolveCanvasSize(allFrames)

  // 4. Build effective timeline
  const effectiveTimes = buildEffectiveTimeline(allFrames)

  // 5. Write to /tmp
  const workDir = mkdtempSync(join(tmpdir(), `canvas-${sessionId}-`))
  try {
    const framePaths = await writeFrames(allFrames, workDir, maxW, maxH, hasVaryingSizes)

    // 6. Build concat.txt
    const concatPath = join(workDir, 'concat.txt')
    writeFileSync(concatPath, buildConcatFile(framePaths, effectiveTimes), 'utf-8')

    // 7. Encode
    const outputVideo = join(workDir, `${sessionId}.mp4`)
    execSync([
      'ffmpeg', '-y',
      '-f', 'concat', '-safe', '0', '-i', concatPath,
      '-c:v', 'libaom-av1', '-pix_fmt', 'yuv420p', '-vsync', 'vfr',
      '-crf', '32', '-cpu-used', '6', '-row-mt', '1', '-tiles', '2x2',
      '-movflags', '+faststart',
      outputVideo,
    ].join(' '), { stdio: 'pipe' })

    // 8. Upload result to S3
    await uploadToS3(outputVideo, `videos/${sessionId}.mp4`)

  } finally {
    // 9. Cleanup
    rmSync(workDir, { recursive: true })
  }
}
```

---

## Key Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_GAP_MS` | `10_000` | Cap idle gaps in timeline |
| `LAST_FRAME_HOLD` | `500` ms | Duration to hold the final frame |
| `CRF` | `32` | AV1 quality (higher = smaller) |
| `CPU_USED` | `6` | AV1 speed preset (0=slow/best, 8=fast) |
| Frame naming | `src-{i:05d}.webp` | Zero-padded, 5 digits |

---

## Dependencies

- `ffmpeg` with `libaom-av1` support (verify: `ffmpeg -encoders | grep libaom`)
- `sharp` (for reading WebP metadata + resizing varying-size frames)
- `@aws-sdk/client-s3` (for S3 operations)
- `node:zlib` (gunzip)
