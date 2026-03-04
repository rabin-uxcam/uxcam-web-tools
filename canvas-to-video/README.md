# Canvas Batch → Video Converter

Test tool that downloads canvas batch `.bin` files from MinIO/S3, extracts the frames, and assembles them into an MP4 video.

## Prerequisites

- **Node.js** 18+
- **ffmpeg** — `brew install ffmpeg`
- **MinIO** running locally (or S3 access)

## Install

```bash
cd tools/canvas-to-video
npm install
```

## Usage

### From MinIO (default)

```bash
# Uses default MinIO settings (localhost:9000, minioadmin/minioadmin)
node index.mjs

# Custom MinIO endpoint
MINIO_ENDPOINT=http://localhost:9000 node index.mjs

# Specific bucket/prefix
node index.mjs --bucket uxcam-sessions --prefix sessions/canvas/

# Custom FPS for output video
node index.mjs --fps 1
```

### From local directory

If you've already downloaded the `.bin` batch files:

```bash
node index.mjs --dir ./my-batches
```

### Custom output directory

```bash
node index.mjs --output ./my-output
```

## Output

```
output/
  {session-id}/
    frames/
      frame-00000.webp (or .png)
      frame-00001.webp
      ...
    {session-id}.mp4
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MINIO_ENDPOINT` | `http://localhost:9000` | MinIO/S3 endpoint |
| `MINIO_ACCESS_KEY` | `minioadmin` | Access key |
| `MINIO_SECRET_KEY` | `minioadmin` | Secret key |
| `CANVAS_BUCKET` | `uxcam-sessions` | S3 bucket name |
| `CANVAS_PREFIX` | `sessions/canvas/` | Object key prefix |

## Binary Format

Each `.bin` file is gzipped and contains:

```
[4 bytes: metadata length (big-endian uint32)]
[N bytes: metadata JSON]
[M bytes: concatenated frame image blobs]
```

Metadata JSON:
```json
{
  "batchIndex": 0,
  "frames": [
    { "time": 1234567, "width": 1170, "height": 992, "offset": 0, "size": 15432 },
    { "time": 1235567, "width": 1170, "height": 992, "offset": 15432, "size": 16200 }
  ]
}
```
