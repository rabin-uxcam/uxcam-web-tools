# Canvas Capture & Video Conversion

End-to-end documentation for the activity-based canvas frame capture system and the batch-to-video conversion pipeline.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Frontend: Canvas Capture](#frontend-canvas-capture)
   - [Flutter Detection](#flutter-detection)
   - [RAF Capture Loop](#raf-capture-loop)
   - [Worker Encoding Pipeline](#worker-encoding-pipeline)
   - [Batch Packing & Upload](#batch-packing--upload)
4. [Binary Wire Format](#binary-wire-format)
   - [Format V2 (Current)](#format-v2-current--gzipped-json-metadata--raw-blobs)
   - [Format V1 (Legacy)](#format-v1-legacy--raw-json-metadata--offset-blobs)
   - [Format JSON](#format-json--base64-data-urls)
5. [Backend: Batch-to-Video Conversion](#backend-batch-to-video-conversion)
   - [CFR Mode (Constant Frame Rate)](#cfr-mode-constant-frame-rate)
   - [VFR Mode (Variable Frame Rate)](#vfr-mode-variable-frame-rate)
   - [Manifest Output](#manifest-output)
6. [Dev Server](#dev-server)
   - [API Endpoints](#api-endpoints)
   - [Player UI](#player-ui)
7. [File Reference](#file-reference)
8. [Configuration Constants](#configuration-constants)

---

## Overview

The system captures visual snapshots of a Flutter Web application's canvas, packages them into compressed binary batches, uploads them to S3, and later converts them into playable MP4 videos.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (Browser SDK)                         │
│                                                                       │
│  Flutter Canvas ──► Continuous RAF loop (throttled to 5 FPS)          │
│                           │                                           │
│                     createImageBitmap                                  │
│                           │                                           │
│                     Web Worker (occlusion + encode to WebP            │
│                                + frame deduplication)                 │
│                           │                                           │
│                     frameBuffer[] ──► Batch Pack (3s / 60KB)          │
│                           │                                           │
│                     gzip metadata + raw blobs ──► S3 Presigned POST   │
│                     + CANVAS_FRAME_REF marker in DOM stream           │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│                     BACKEND (canvas-to-video tool)                     │
│                                                                       │
│  S3 batch-XXXX.bin files                                              │
│       │                                                               │
│       ▼                                                               │
│  gunzip ──► parseBatch() ──► extract frames (WebP blobs + metadata)   │
│       │                                                               │
│       ▼                                                               │
│  WebP passthrough (same-size) or sharp resize → WebP (varying sizes)  │
│       │                                                               │
│       ├── CFR: duplicate frames to fill gaps ──► ffmpeg -framerate N  │
│       │                                                               │
│       └── VFR: concat demuxer with per-frame durations ──► ffmpeg     │
│                                                                       │
│       ▼                                                               │
│  output/<sessionId>/<sessionId>.mp4                                   │
│  + manifest.json (VFR only)                                           │
│  + concat.txt (VFR only)                                              │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Architecture

### Why Continuous RAF + Worker Deduplication?

The capture loop runs continuously at up to `MAX_CAPTURE_FPS` (5 FPS) using `requestAnimationFrame`. Every frame is sent to a Web Worker which handles **frame deduplication** — comparing encoded WebP bytes with the previous frame and skipping identical ones. This means idle periods produce **zero emitted frames** automatically, with no polling or state machine needed on the main thread.

This approach is simpler than pixel-sampling change detection (which was removed) and avoids the issues with WebGL prototype monkey-patching (Flutter/CanvasKit is compiled via Emscripten/WASM, which bypasses JavaScript prototypes).

---

## Frontend: Canvas Capture

**Source**: `uxcam-websdk-frontend/src/sdk/client/Collect/FlutterCanvasManager.ts`

### Flutter Detection

`detectFlutterWeb()` finds the Flutter canvas by:

1. Checking for Flutter engine globals (`window._flutter`, `window.flutterConfiguration`)
2. Looking for `flutter-view` and `flt-glass-pane` shadow host elements
3. Piercing shadow DOM boundaries recursively (`findCanvasDeep()`) — checks most specific host first (`flt-glass-pane`), then falls back to `flutter-view`
4. Detecting rendering mode (CanvasKit, Skwasm, HTML) via heuristics:
   - `_flutter.loader.config.renderer === 'skwasm'` → Skwasm
   - `_ckSurface` / `grContext` properties → CanvasKit
   - DPR-scaled canvas dimensions → CanvasKit
   - Default fallback → CanvasKit (most common Flutter Web renderer)

A canvas is confirmed as Flutter when it's found AND either a Flutter engine global or a host element is present.

### RAF Capture Loop

A single continuous `requestAnimationFrame` loop captures frames at up to `MAX_CAPTURE_FPS` (5 FPS). The worker handles frame deduplication, so no change-detection polling or state machine is needed on the main thread.

```
┌────────────────────────────────────────────────────────────────┐
│                     RAF Loop (continuous)                       │
│                                                                │
│  requestAnimationFrame ──► FPS throttle check                  │
│       │                        │                               │
│       │                   Too soon? → skip, schedule next RAF  │
│       │                        │                               │
│       │                   Snapshot in progress? → skip         │
│       │                        │                               │
│       │                   captureSnapshot()                    │
│       │                        │                               │
│       │              createImageBitmap(canvas)                 │
│       │                        │                               │
│       │              postMessage to Worker                     │
│       │              (bitmap transferred zero-copy)            │
│       │                        │                               │
│       ▼                        ▼                               │
│  schedule next RAF    Worker: encode → dedup → emit or skip    │
└────────────────────────────────────────────────────────────────┘
```

**Key behaviors**:
- **FPS throttle**: Skips frames if less than `1000 / MAX_CAPTURE_FPS` ms since the last snapshot
- **Backpressure**: Skips frames while a previous snapshot is still being processed by the worker
- **WebGL hack**: For canvases with `preserveDrawingBuffer=false`, calls `gl.clear(COLOR_BUFFER_BIT)` before `createImageBitmap` to force canvas contents back into memory
- **Resolution scaling**: Frames are scaled down preserving aspect ratio, capped at `CANVAS_TARGET_RESOLUTION` (default: 1920×1080 FullHD)
- **Occlusion**: Dart-side occlusion rects obtained via `window.__uxcam_getOcclusionRects()` callback, scaled to match target dimensions
- **Visibility handling**: RAF loop pauses when page is hidden (`visibilitychange`), resumes when visible

### Worker Encoding Pipeline

The Web Worker (`canvas-snapshot-worker.ts`) receives `ImageBitmap` frames via `postMessage` (zero-copy transfer):

```
Main Thread                          Worker
    │                                    │
    │  postMessage({bitmap, ...})        │
    │  ─────────────────────────────►    │
    │  [ImageBitmap transferred]         │
    │                                    │  1. Draw to OffscreenCanvas (scaled)
    │                                    │  2. Apply occlusion rects (black boxes)
    │                                    │  3. convertToBlob({type, quality})
    │                                    │  4. blob.arrayBuffer()
    │                                    │  5. Frame deduplication:
    │                                    │     - First frame: skip if < 1KB (transparent)
    │                                    │     - Compare encoded bytes with last frame
    │                                    │     - Early-exit byte comparison on first diff
    │                                    │     - If identical → { skipped: true }
    │                                    │
    │  postMessage({buffer, ...})        │  (unique frame)
    │  ◄─────────────────────────────    │
    │  [ArrayBuffer transferred]         │
    │                                    │
    │  postMessage({skipped: true})      │  (duplicate frame)
    │  ◄─────────────────────────────    │
    │                                    │
```

The worker is inlined as a Blob URL string in `FlutterCanvasManager.ts` (because IIFE builds can't use `new URL('./worker.ts', import.meta.url)`). The reference TypeScript source is in `canvas-snapshot-worker.ts`.

**Fallback**: If the worker fails to initialize, `mainThreadEncode()` uses a regular `<canvas>` element + `canvas.toDataURL()` on the main thread (synchronous, slower). The resulting data URL is decoded back to binary for the batch buffer.

### Batch Packing & Upload

Encoded frames are buffered in `frameBuffer[]` (as raw `ArrayBuffer` + metadata) and flushed as binary batches:

- **Flush triggers**: Every `BATCH_FLUSH_INTERVAL_MS` (3s) OR when `bufferByteSize` exceeds `BATCH_BUFFER_SIZE_LIMIT` (60KB)
- **Binary pack (V2)**: `[4-byte gzipped JSON length][gzipped JSON metadata][concatenated raw WebP blobs]`
  - JSON metadata: `[{t, sz, w, h}, ...]` — compact per-frame metadata (timestamp, size, width, height)
  - Frame blobs: concatenated sequentially, unpacked using `sz` field (no offset needed)
  - Only the JSON metadata is gzip-compressed (via `CompressionStream`); WebP blobs are already compressed
- **Upload**: S3 presigned POST (FormData), key: `batch-XXXX.bin` (zero-padded batchIndex). The `${filename}` placeholder in the presigned key is replaced with the batch filename
- **Retry**: Failed uploads are retried once after a 1-second delay; dropped on second failure
- **Sync marker**: A `CANVAS_FRAME_REF` (ChangeType `'27'`) is emitted into the DOM change stream for each frame, containing `batchIndex` and `frameIndex`
- **Persistence**: `batchIndex` stored in `sessionStorage` (`uxcam:0.1:session:batchIndex`) to survive page reloads and avoid S3 key collisions
- **Destroy**: On teardown, remaining buffered frames are flushed, RAF loop is cancelled, visibility handler removed, worker terminated, and batch flush timer cleared

---

## Binary Wire Format

Three batch formats are supported. The parser (`parse-batch.mjs`) auto-detects the format.

### Format V2 (Current) — Gzipped JSON Metadata + Raw Blobs

Each `.bin` file (after outer gunzip) has this structure:

```
Offset    Size       Description
──────    ────       ───────────
0         4 bytes    Gzipped JSON length N (big-endian uint32)
4         N bytes    Gzipped JSON metadata
4+N       M bytes    Concatenated raw WebP blobs (sequential)
```

**Detection**: bytes at offset 4 start with gzip magic `0x1F 0x8B`.

**Metadata JSON** (after gunzip):

```json
[
  { "t": 1710245123456, "sz": 45230, "w": 1920, "h": 1080 },
  { "t": 1710245123678, "sz": 44890, "w": 1920, "h": 1080 }
]
```

| Field | Description |
|-------|-------------|
| `t` | Capture timestamp (milliseconds, session-relative) |
| `sz` | Byte size of this frame's WebP blob |
| `w` | Frame width in pixels |
| `h` | Frame height in pixels |

Frames are unpacked sequentially using a cursor — no explicit offset needed:

```javascript
const dataStart = 4 + gzippedJsonLen
let cursor = 0
const frames = meta.map(f => {
  const data = buffer.subarray(dataStart + cursor, dataStart + cursor + f.sz)
  cursor += f.sz
  return { time: f.t, width: f.w, height: f.h, data }
})
```

### Format V1 (Legacy) — Raw JSON Metadata + Offset Blobs

```
Offset    Size       Description
──────    ────       ───────────
0         4 bytes    Metadata length N (big-endian uint32)
4         N bytes    Raw JSON metadata (UTF-8)
4+N       M bytes    Concatenated frame blobs (WebP image data)
```

**Detection**: first byte after 4-byte header is NOT gzip magic (not `0x1F 0x8B`), and first byte of file is NOT `[` (`0x5B`).

**Metadata JSON**:

```json
{
  "batchIndex": 3,
  "frames": [
    { "time": 1710245123456, "width": 1920, "height": 1080, "offset": 0, "size": 45230 },
    { "time": 1710245123678, "width": 1920, "height": 1080, "offset": 45230, "size": 44890 }
  ]
}
```

Frames are extracted using explicit `offset` and `size` fields:

```javascript
const dataStart = 4 + metaLen
const frames = meta.frames.map(f => ({
  ...f,
  data: buffer.subarray(dataStart + f.offset, dataStart + f.offset + f.size),
}))
```

### Format JSON — Base64 Data URLs

A JSON array of change objects with inline base64-encoded image data URLs.

**Detection**: first byte is `[` (`0x5B`).

```json
[
  {
    "time": 1710245123456,
    "data": "data:image/webp;base64,UklGR..."
  }
]
```

Frames are decoded from base64. Width/height are inferred from the image data at processing time.

---

## Backend: Batch-to-Video Conversion

**Source**: `tools/canvas-to-video/index.mjs`

Both modes share the initial pipeline:

1. Download `.bin` files from S3/MinIO (or read from local directory)
2. Gunzip each batch
3. Parse binary wire format via `parseBatch()` (auto-detects V2, V1, or JSON format)
4. Sort all frames by timestamp
5. Determine uniform video dimensions (max width/height across all frames, rounded to even numbers for libx264)
6. Write intermediate frames:
   - **Same-size frames**: Raw WebP passthrough (zero re-encoding)
   - **Varying-size frames**: `sharp` resize/pad to uniform dimensions → WebP (quality 80)
7. Clean frames directory before each run (prevents stale files from prior runs)

### CFR Mode (Constant Frame Rate)

**Function**: `processSession()`

Produces a video at a fixed frame rate (default 5 FPS) by duplicating frames to fill time gaps.

```
Source frames (irregular):   F0──────F1──F2────────────────F3──F4
                             |       |   |                 |   |
Video frames (5 FPS):        F0 F0 F0 F1 F2 F2 F2 F2 F2 F2 F3 F4

Each gap is filled by repeating the previous frame.
```

**ffmpeg command**:
```bash
ffmpeg -y -framerate 5 -i frames/frame-%05d.webp \
  -c:v libx264 -pix_fmt yuv420p -crf 28 -preset fast \
  output/<sessionId>/<sessionId>.mp4
```

**Output structure**:
```
output/<sessionId>/
├── <sessionId>.mp4          # Final video
└── frames/
    ├── src-00000.webp       # Source frames (unique images)
    ├── src-00001.webp
    ├── frame-00000.webp     # Video frames (copies of source frames)
    ├── frame-00001.webp     # (some are duplicates to fill time)
    └── ...
```

**Pros**: Simple, compatible with all players.
**Cons**: Larger files due to frame duplication. Time accuracy limited to frame rate intervals.

### VFR Mode (Variable Frame Rate)

**Function**: `processSessionVFR()`

Preserves exact frame timing using ffmpeg's **concat demuxer** with per-frame duration directives. No frame duplication — each source frame appears exactly once with its real duration.

```
Source frames (irregular):   F0──────F1──F2────────────────F3──F4
                             |       |   |                 |   |
VFR frames:                  F0(1.2s) F1(0.4s) F2(3.4s) F3(0.2s) F4(0.5s)

Each frame is shown for exactly its computed duration.
```

**concat.txt** (generated):
```
file '/path/to/frames-vfr/frame-00000.webp'
duration 1.200000
file '/path/to/frames-vfr/frame-00001.webp'
duration 0.400000
file '/path/to/frames-vfr/frame-00002.webp'
duration 3.400000
file '/path/to/frames-vfr/frame-00003.webp'
duration 0.200000
file '/path/to/frames-vfr/frame-00004.webp'
duration 0.500000
file '/path/to/frames-vfr/frame-00004.webp'
```

> The last file is repeated without a duration line (ffmpeg concat demuxer requirement).

**Duration rules**:
- Each frame's duration = time until next frame
- Idle gaps clamped to max **10 seconds** (avoids excessively long videos)
- Last frame held for **0.5 seconds**
- Minimum duration: **0.001s** (ffmpeg requires > 0)

**ffmpeg command**:
```bash
ffmpeg -y -f concat -safe 0 -i concat.txt \
  -c:v libx264 -pix_fmt yuv420p -vsync vfr -crf 28 -preset fast \
  output/<sessionId>/<sessionId>.mp4
```

**Output structure**:
```
output/<sessionId>/
├── <sessionId>.mp4          # Final video
├── concat.txt               # ffmpeg concat demuxer input
├── manifest.json            # Detailed batch + frame metadata
└── frames-vfr/
    ├── frame-00000.webp
    ├── frame-00001.webp
    └── ...
```

**Pros**: Smaller files, exact timing preserved, fewer frames to encode.
**Cons**: VFR playback may behave differently in some players.

### Manifest Output

VFR mode writes a `manifest.json` with detailed information about each batch file and frame:

```json
{
  "session": "1773300833892-e2b3b88a92c3ae0b",
  "totalBatches": 4,
  "totalFrames": 87,
  "timeSpanMs": 24500,
  "videoSize": { "width": 1920, "height": 1080 },
  "batches": [
    {
      "file": "batch-0000.bin",
      "batchIndex": 0,
      "rawSizeBytes": 523400,
      "compressedSizeBytes": 498200,
      "frameCount": 22,
      "frames": [
        { "time": 1710245123456, "width": 1920, "height": 1080, "sizeBytes": 45230 },
        { "time": 1710245123678, "width": 1920, "height": 1080, "sizeBytes": 44890 }
      ],
      "timeRange": {
        "start": 1710245123456,
        "end": 1710245127890,
        "spanMs": 4434
      }
    }
  ],
  "frames": [
    {
      "index": 0,
      "batchIndex": 0,
      "time": 1710245123456,
      "width": 1920,
      "height": 1080,
      "durationMs": 222,
      "file": "frame-00000.webp"
    }
  ]
}
```

---

## Dev Server

**Source**: `tools/canvas-to-video/server.mjs`

A Node.js HTTP server for testing the conversion pipeline with a browser-based player.

### Starting the Server

```bash
cd tools/canvas-to-video
node server.mjs              # default port 5505
PORT=8080 node server.mjs    # custom port
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serves `player.html` |
| `POST` | `/convert` | Converts S3 batches to MP4 |
| `GET` | `/minio/*` | Proxies to MinIO (avoids CORS) |
| `GET` | `/output` | Lists output directory (JSON) |
| `GET` | `/output/<sessionId>/` | Lists session output files (JSON) |
| `GET` | `/output/<sessionId>/<file>` | Serves static files (mp4, json, png) |

#### POST /convert

Request body:
```json
{
  "sessionId": "1773300833892-e2b3b88a92c3ae0b",
  "minioUrl": "http://localhost:9000",
  "bucket": "uxcam-sessions",
  "prefix": "sessions/canvas/",
  "mode": "vfr",
  "accessKey": "minioadmin",
  "secretKey": "minioadmin"
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `sessionId` | *(required)* | Session identifier |
| `mode` | `"cfr"` | `"cfr"` for constant frame rate, `"vfr"` for variable frame rate |
| `minioUrl` | `http://localhost:9000` | MinIO/S3 endpoint |
| `bucket` | `uxcam-sessions` | S3 bucket name |
| `prefix` | `sessions/canvas/` | Key prefix for canvas batch files |
| `accessKey` | `minioadmin` | S3 access key |
| `secretKey` | `minioadmin` | S3 secret key |

Response (success):
```json
{
  "videoUrl": "/output/<sessionId>/<sessionId>.mp4",
  "videoPath": "/abs/path/to/output/<sessionId>/<sessionId>.mp4",
  "framesDir": "/abs/path/to/output/<sessionId>/frames-vfr",
  "frameCount": 87,
  "videoFrameCount": 87,
  "videoSizeBytes": 2345678,
  "manifestPath": "/abs/path/to/manifest.json",
  "concatFilePath": "/abs/path/to/concat.txt",
  "manifest": { ... }
}
```

#### GET /output (Directory Listing)

Returns JSON listing of directories and files:

```json
{
  "path": "/output",
  "entries": [
    {
      "name": "1773300833892-e2b3b88a92c3ae0b",
      "type": "directory",
      "modified": "2026-03-12T07:27:00.000Z"
    }
  ]
}
```

```json
{
  "path": "/output/1773300833892-e2b3b88a92c3ae0b",
  "entries": [
    { "name": "1773300833892-e2b3b88a92c3ae0b.mp4", "type": "file", "size": 59212911, "modified": "..." },
    { "name": "concat.txt", "type": "file", "size": 12340, "modified": "..." },
    { "name": "manifest.json", "type": "file", "size": 45678, "modified": "..." },
    { "name": "frames-vfr", "type": "directory", "modified": "..." }
  ]
}
```

### Player UI

The `player.html` page provides:

- **Session browser**: Lists canvas sessions from MinIO, selects data.json files
- **Video player**: HTML5 `<video>` element with the converted MP4
- **Overlays**: Screen name banner, click dot trail visualization
- **Event log**: Timestamped event sidebar with click-to-seek
- **Timeline**: Scrubber with event markers (orange) and screen transition markers (green)
- **Keyboard**: Space (play/pause), Left/Right arrows (seek ±1s)
- **Speed**: 0.5x, 1x, 2x, 4x playback

---

## File Reference

| File | Description |
|------|-------------|
| `uxcam-websdk-frontend/src/sdk/client/Collect/FlutterCanvasManager.ts` | Canvas capture (detection, RAF loop, worker dedup, batching, upload) |
| `uxcam-websdk-frontend/src/sdk/client/Collect/canvas-snapshot-worker.ts` | Reference TypeScript source for the inline Web Worker |
| `tools/canvas-to-video/index.mjs` | Batch parser + CFR/VFR video conversion (ffmpeg) |
| `tools/canvas-to-video/parse-batch.mjs` | Binary wire format parser (auto-detects V2, V1, JSON) |
| `tools/canvas-to-video/server.mjs` | Dev server (convert API, MinIO proxy, directory listing) |
| `tools/canvas-to-video/player.html` | Browser-based session replay player |
| `tools/bin-visualizer/index.html` | Browser-based .bin batch file inspector (hex view, frame preview, timeline) |

---

## Configuration Constants

### Capture (FlutterCanvasManager.ts)

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_CAPTURE_FPS` | `5` | Max capture rate during RAF loop |
| `CANVAS_IMAGE_TYPE` | `'image/webp'` | Encoded image format |
| `CANVAS_IMAGE_QUALITY` | `0.8` | WebP quality (0-1) |
| `CANVAS_TARGET_RESOLUTION` | `1920×1080` | Max capture resolution (FullHD preset). Frames scaled down preserving aspect ratio |
| `BATCH_FLUSH_INTERVAL_MS` | `3000` | Batch upload interval |
| `BATCH_BUFFER_SIZE_LIMIT` | `60,000` | Max batch size before early flush (~60KB, fits within 64KB fetch keepalive limit) |
| `TRANSPARENT_THRESHOLD_BYTES` | `1024` | Worker-side: first frame skipped if encoded size < 1KB (likely transparent/unrendered) |

**Resolution presets** (only one is active at a time via `CANVAS_TARGET_RESOLUTION`):

| Preset | Width | Height |
|--------|-------|--------|
| FullHD | 1920 | 1080 |
| HD | 1280 | 720 |
| SD | 854 | 480 |

### Conversion (index.mjs)

| Constant / Default | Value | Description |
|---------------------|-------|-------------|
| Default FPS (CFR) | `5` | Target frame rate for constant-frame-rate mode |
| Max idle gap (VFR) | `10s` | Clamp for long pauses between frames |
| Last frame hold (VFR) | `0.5s` | How long to display the final frame |
| Min duration (VFR) | `0.001s` | Minimum frame duration (ffmpeg requirement) |
| ffmpeg CRF | `28` | Compression quality (lower = better quality, bigger file; 28 is optimized for screen recordings) |
| ffmpeg preset | `fast` | Encoding speed/compression tradeoff |
