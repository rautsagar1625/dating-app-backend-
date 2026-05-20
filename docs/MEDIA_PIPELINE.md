# Media + CDN Pipeline

Production-grade media infrastructure for the Velvet dating app.

---

## Architecture Overview

```
Client
  │
  ├─ POST /api/media/upload-url        ← request presigned URL
  │       ↓
  │  Backend validates + creates session
  │  Returns presigned S3 PUT URL (15 min TTL)
  │
  ├─ PUT <presignedUrl>                ← upload directly to S3
  │       ↓
  │  S3 temp bucket receives file
  │  (zero backend bandwidth)
  │
  ├─ POST /api/media/upload-url/:sessionId/complete
  │       ↓
  │  Backend: HeadObject → magic-byte MIME check → size check
  │  Enqueues BullMQ process-image job
  │  Returns { assetId, status: "PROCESSING" }
  │
  │        [BullMQ: media-process worker]
  │              ↓
  │        Download from temp S3
  │        sharp: orient + strip EXIF
  │        Generate 9 output files:
  │          4 sizes × 2 formats (WebP + AVIF) + 1 ORIGINAL JPEG
  │        Compute blurhash + perceptual hash + SHA-256
  │        Upload variants to final bucket
  │        Update DB → status: READY
  │        Delete temp object
  │              ↓
  │        [BullMQ: media-moderate worker]
  │              ↓
  │        NSFW scan (pluggable provider)
  │        pHash blocklist check
  │        Near-duplicate detection
  │        Update moderationState: APPROVED / QUARANTINED / REJECTED
  │
  └─ GET /api/media/:assetId/url       ← get CDN URL
          ↓
     Access check (owner or granted)
     Build signed CloudFront URL
     Cache in Redis (TTL − 60s)
     Return { url, blurhash, expiresAt }
```

---

## Bucket Layout

| Bucket | Purpose | CDN | Access |
|---|---|---|---| 
| `velvet-media-temp` | Raw upload landing zone | None | App IAM role only |
| `velvet-media-public` | Processed profile photos | Public CloudFront | World-readable via CF OAC |
| `velvet-media-private` | Private photos, verification selfies | Signed CloudFront | Signed URL required |
| `velvet-media-chat` | Chat attachments | Signed CloudFront | Signed URL required |
| `velvet-media-quarantine` | Moderation-flagged content | None | Admin IAM role only |

**S3 lifecycle rule on `velvet-media-temp`:** objects auto-deleted after 24 hours (protects against orphans from failed sessions).

**S3 key format:**
```
{userId}/{mediaType}/{assetId}/{variantType}_{format}.{ext}

# Examples
u123/PROFILE_PHOTO/abc/MEDIUM_WEBP.webp
u123/PROFILE_PHOTO/abc/THUMB_AVIF.avif
u123/PRIVATE_PHOTO/xyz/LARGE_WEBP.webp
```

---

## Image Variants

Each uploaded image produces **9 output files**:

| Variant | Dimensions | Formats | Fit |
|---|---|---|---|
| THUMB | 160 × 160 | WebP, AVIF | cover (square crop) |
| SMALL | 320 × 320 | WebP, AVIF | inside (preserve ratio) |
| MEDIUM | 640 × 640 | WebP, AVIF | inside |
| LARGE | 1200 × 1200 | WebP, AVIF | inside |
| ORIGINAL | original size | JPEG (progressive) | — |

**Also computed per asset:**
- **Blurhash** — 4×3 component (~30 bytes), returned inline in API responses for instant placeholders
- **Perceptual hash** — 64-bit average hash (16 hex chars), used for near-duplicate detection
- **SHA-256** — integrity verification

**Processing settings:**
- WebP: quality 82, effort 4, smart subsampling
- AVIF: quality 70, effort 3
- JPEG: quality 88, progressive, mozjpeg
- All EXIF/metadata stripped on ingest (privacy)

---

## Upload Limits

| Media Type | Max Size | Allowed MIME Types |
|---|---|---|
| `PROFILE_PHOTO` | 15 MB | jpeg, png, webp, heic, heif |
| `PRIVATE_PHOTO` | 15 MB | jpeg, png, webp, heic, heif |
| `CHAT_ATTACHMENT` | 25 MB | jpeg, png, webp, gif, mp4 |
| `VERIFICATION_SELFIE` | 10 MB | jpeg, png, webp |
| `VIDEO` *(future)* | 200 MB | mp4, quicktime, webm |

**Rate limit:** 20 uploads per user per hour (Redis counter, 1-hour sliding window).

---

## Signed URL TTLs

| Media Type | CDN URL TTL | Cache-Control (S3 origin) |
|---|---|---|
| `PROFILE_PHOTO` | 24 hours | `public, max-age=31536000, immutable` |
| `PRIVATE_PHOTO` | 1 hour | `private, no-store` |
| `CHAT_ATTACHMENT` | 24 hours | `private, no-store` |
| `VERIFICATION_SELFIE` | 15 minutes | `private, no-store` |

Signed CDN URLs are cached in Redis with TTL − 60s so the API doesn't re-sign on every request while a URL is still valid.

---

## CDN Configuration (CloudFront)

**Public distribution** (`cdn-public.velvet.app` → `velvet-media-public`):
- Origin: S3 with OAC (Origin Access Control) — S3 bucket is NOT public
- Cache policy: Managed-CachingOptimized (compress, long TTL)
- No signed URLs required

**Private distributions** (`cdn-private.velvet.app`, `cdn-chat.velvet.app`):
- Origin: S3 with OAC
- Trusted key groups: the app's RSA key pair
- CloudFront rejects requests without a valid signature before touching the origin
- Signed URL generated using `@aws-sdk/cloudfront-signer` with the app's private key

**Key rotation (zero-downtime):**
1. Generate new key pair, add to trusted key groups
2. Update `CF_KEY_PAIR_ID` + `CF_PRIVATE_KEY` in app config
3. Keep old key pair active for the max URL TTL window (1h)
4. Remove old key pair from trusted key groups

---

## Moderation Pipeline

**States:** `UNREVIEWED` → `PENDING` → `APPROVED` / `REJECTED` / `QUARANTINED`

**Automatic flow:**
1. Worker downloads `MEDIUM_WEBP` variant (smaller = faster scan)
2. Exact pHash blocklist check in Redis — `O(1)` lookup
3. Near-duplicate detection — Hamming distance ≤ 10 against existing assets
4. NSFW scan via pluggable provider

**Score thresholds (NSFW scan):**
- `< 0.60` → APPROVED
- `0.60–0.85` → QUARANTINED (human review queue)
- `>= 0.85` → REJECTED + asset quarantined

**Fail-safe:** if the scan throws an error, the asset is QUARANTINED — never auto-approved on errors.

**Plugging in a real NSFW provider:**
Implement the `NsfwProvider` interface in `src/services/media/moderation.service.ts`:
```typescript
interface NsfwProvider {
  scan(imageBuffer: Buffer): Promise<{
    isNsfw: boolean;
    nsfwScore: number;   // 0.0 – 1.0
    labels: string[];
    raw: Record<string, unknown>;
  }>;
}
```
Providers to consider: AWS Rekognition `DetectModerationLabels`, SightEngine, Google Cloud Vision SafeSearch.

**pHash blocklist management:**
```typescript
import { addHashToBlocklist } from './services/media/moderation.service';
await addHashToBlocklist('a3f7c91b2d4e8056');  // adds to Redis Set
```

---

## Database Schema

### MediaAsset
Master record for every media object.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | primary key |
| `userId` | uuid | owner |
| `mediaType` | string | PROFILE_PHOTO / PRIVATE_PHOTO / CHAT_ATTACHMENT / VERIFICATION_SELFIE / VIDEO |
| `status` | string | PENDING / UPLOADED / PROCESSING / READY / FAILED / DELETED / QUARANTINED |
| `moderationState` | string | UNREVIEWED / PENDING / APPROVED / REJECTED / QUARANTINED |
| `s3Bucket` | string | final bucket after processing |
| `s3Key` | string | final key (ORIGINAL JPEG) |
| `tempS3Key` | string? | temp key during upload phase |
| `cdnDomain` | string? | e.g. `cdn-public.velvet.app` |
| `mimeType` | string | declared MIME (magic-byte validated) |
| `fileSizeBytes` | int | original file size |
| `width` / `height` | int? | original dimensions |
| `perceptualHash` | string? | 16-hex aHash |
| `sha256Hash` | string? | integrity |
| `blurhash` | string? | 4×3 blurhash |

### MediaVariant
One record per size/format combination (up to 9 per asset).

### UploadSession
Tracks the presigned upload lifecycle. Expired sessions cleaned up hourly.

### MediaModeration
Append-only scan results. Multiple records per asset allowed (re-scans, different providers, manual overrides).

### MediaAccessLog
Audit trail: every signed CDN URL issued for a private asset.

---

## Redis Key Space

| Key | TTL | Purpose |
|---|---|---|
| `velvet:media:rate:{userId}` | 1 hour | Upload rate limiter counter |
| `velvet:upload:session:{sessionId}` | 15 min | Session fast-path cache |
| `velvet:media:access:{userId}:{assetId}` | = URL TTL | Access grant cache |
| `velvet:media:url:{userId}:{assetId}:{variant}` | TTL − 60s | Signed URL cache |
| `velvet:media:phash:blocklist` | permanent | Redis Set of blocked perceptual hashes |

---

## Queue Architecture

| Queue | Worker | Concurrency | Job Type |
|---|---|---|---|
| `media-process` | `mediaProcessWorker` | 4 | CPU-bound: sharp image processing |
| `media-moderate` | `mediaModerateWorker` | 8 | I/O-bound: NSFW API calls |
| `media-cleanup` | `mediaCleanupWorker` | 1 | Maintenance: expire sessions, delete temp |

**Retry policy:**
- `media-process`: 3 attempts, exponential backoff from 5s
- `media-moderate`: 2 attempts, fixed 10s delay
- Failed jobs land in BullMQ's failed state for inspection

**Scaling strategy:**
- Processing workers are CPU-bound → scale by adding replicas (not increasing concurrency per pod)
- Moderation workers are I/O-bound → can safely increase concurrency to 20–30
- Run queues on separate K8s Deployments so they can scale independently

---

## API Reference

### `POST /api/media/upload-url`
Request a presigned S3 PUT URL.

**Body:**
```json
{ "mediaType": "PROFILE_PHOTO", "mimeType": "image/jpeg", "fileSize": 1048576 }
```

**Response:**
```json
{
  "sessionId": "uuid",
  "assetId": "uuid",
  "uploadUrl": "https://velvet-media-temp.s3.amazonaws.com/...",
  "expiresAt": "2026-05-13T12:15:00Z"
}
```

### `PUT <uploadUrl>`
Upload the file directly to S3. Must set `Content-Type: image/jpeg` (or the declared MIME). No `Authorization` header — the presigned URL is self-authenticated.

### `POST /api/media/upload-url/:sessionId/complete`
Confirm upload. Triggers processing queue.

**Response:** `{ "assetId": "uuid", "status": "PROCESSING" }`

### `GET /api/media/:assetId/url?variant=MEDIUM&format=WEBP`
Get a CDN URL for the asset. Returns 202 if still processing.

**Response:**
```json
{
  "url": "https://cdn-private.velvet.app/...?Expires=...&Signature=...",
  "variantType": "MEDIUM",
  "format": "WEBP",
  "width": 640,
  "height": 480,
  "blurhash": "LKO2?U%2Tw=w]~RBVZRi};RPxuwH",
  "expiresAt": "2026-05-13T13:00:00Z"
}
```

### `GET /api/media/:assetId`
Asset metadata — all variants, dimensions, blurhash, status.

### `DELETE /api/media/:assetId`
Soft delete (owner only). Sets `status: DELETED`.

### `GET /api/media/me?mediaType=PROFILE_PHOTO`
List your own assets.

### `GET /api/media/admin/moderation-queue?state=QUARANTINED`
Admin: list assets pending human review.

### `PATCH /api/media/admin/:assetId/moderate`
Admin: override moderation state.
**Body:** `{ "state": "APPROVED" | "REJECTED" | "QUARANTINED", "notes": "..." }`

---

## Frontend Integration

### Upload (React Native / Expo)

```typescript
import { useMediaUpload } from '../hooks/useMediaUpload';
import * as ImagePicker from 'expo-image-picker';

const { upload, uploading, progress } = useMediaUpload();

const pickAndUpload = async () => {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 1,
  });
  if (result.canceled) return;

  const asset = result.assets[0];
  const { assetId } = await upload({
    uri:       asset.uri,
    mimeType:  asset.mimeType ?? 'image/jpeg',
    fileSize:  asset.fileSize ?? 0,
    mediaType: 'PROFILE_PHOTO',
  });

  // assetId is immediately usable. Asset becomes READY asynchronously (~2–5s).
};
```

### Display with blurhash placeholder

```typescript
import { fetchMediaUrl, selectVariantForScreen } from '../utils/mediaUrl';

// 1. Render blurhash immediately (install react-native-blurhash)
// 2. Fetch real URL
// 3. Fade in real image

const variant = selectVariantForScreen(1.0); // picks smallest variant that covers screen
const { url, blurhash } = await fetchMediaUrl(assetId, variant, 'WEBP');
```

### Responsive variant selection

```typescript
import { selectVariant } from '../utils/mediaUrl';

// Avatar in a list (60px display)
const variant = selectVariant(60);  // → 'THUMB'

// Full-screen image (375px display × 2x pixel ratio = 750px physical)
const variant = selectVariant(375); // → 'MEDIUM' (covers 640px)
```

---

## Environment Variables

```bash
# AWS
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...

# S3 Buckets
S3_BUCKET_PUBLIC=velvet-media-public
S3_BUCKET_PRIVATE=velvet-media-private
S3_BUCKET_CHAT=velvet-media-chat
S3_BUCKET_TEMP=velvet-media-temp
S3_BUCKET_QUARANTINE=velvet-media-quarantine

# CDN Domains
CDN_PUBLIC_DOMAIN=cdn-public.velvet.app
CDN_PRIVATE_DOMAIN=cdn-private.velvet.app
CDN_CHAT_DOMAIN=cdn-chat.velvet.app

# CloudFront signing (private/chat distributions only)
CF_KEY_PAIR_ID=APKAXXXXXXXXXXX
CF_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----

# Local dev: point to MinIO instead of AWS
S3_ENDPOINT=http://localhost:9000
```

---

## Prometheus Metrics

| Metric | Type | Labels |
|---|---|---|
| `velvet_media_uploads_total` | Counter | `mediaType`, `result` |
| `velvet_media_processing_duration_seconds` | Histogram | `stage` |
| `velvet_media_moderation_total` | Counter | `provider`, `result` |
| `velvet_media_variant_size_bytes` | Histogram | `variantType`, `format` |
| `velvet_media_queue_depth` | Gauge | `queue` |
| `velvet_media_signed_url_issued_total` | Counter | `mediaType` |

**Recommended alerts:**
- `velvet_media_queue_depth{queue="media-process"} > 100` — processing backlog
- `increase(velvet_media_moderation_total{result="rejected"}[5m]) > 10` — NSFW spike
- `velvet_media_processing_duration_seconds{stage="process",quantile="0.95"} > 10` — slow processing

---

## Kubernetes Deployment

```yaml
# media-process worker — CPU-bound, needs more vCPUs
apiVersion: apps/v1
kind: Deployment
metadata:
  name: velvet-media-process-worker
spec:
  replicas: 3  # scale based on queue depth
  template:
    spec:
      containers:
        - name: worker
          image: velvet-api:latest
          command: ["node", "dist/workers/media-process.js"]
          resources:
            requests: { cpu: "1000m", memory: "512Mi" }
            limits:   { cpu: "2000m", memory: "1Gi" }
---
# media-moderate worker — I/O-bound, needs network not CPU
apiVersion: apps/v1
kind: Deployment
metadata:
  name: velvet-media-moderate-worker
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: worker
          image: velvet-api:latest
          command: ["node", "dist/workers/media-moderate.js"]
          resources:
            requests: { cpu: "200m", memory: "256Mi" }
            limits:   { cpu: "500m", memory: "512Mi" }
```

**HPA for processing workers:**
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: velvet-media-process-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: velvet-media-process-worker
  minReplicas: 1
  maxReplicas: 10
  metrics:
    - type: External
      external:
        metric:
          name: velvet_media_queue_depth
          selector:
            matchLabels: { queue: media-process }
        target:
          type: AverageValue
          averageValue: "20"  # scale up when >20 jobs/replica
```

---

## Cost Optimization

**Storage tiers:**
- Processed variants → S3 Standard (hot, CDN-served)
- Quarantined content → S3 Standard-IA (infrequent access)
- Deleted assets → S3 Glacier after 30 days (legal hold period)

**CloudFront cost reduction:**
- Enable CloudFront compression (gzip/br) — saves 30–60% on JPEG/WebP egress
- Use Price Class 100 (US/Europe/Asia) instead of All — drops CF cost ~40% for most apps
- Enable CloudFront caching for public variants — only origin misses hit S3

**Processing cost reduction:**
- AVIF encoding is slow (3–5× WebP) — consider generating AVIF only for LARGE/MEDIUM on first access, not upfront
- Use `withoutEnlargement: true` in sharp — avoids upscaling small images wasting CPU

**Bandwidth:**
- AVIF saves ~50% vs JPEG, WebP saves ~30% — significant at scale
- THUMB variant serves all list/grid views — medium variant only loaded on profile open

---

## Future: Video Transcoding

The architecture is ready for video. To add support:

1. Add `VIDEO` media type to `UPLOAD_LIMITS` (already present, 200 MB)
2. Add a `media-transcode` BullMQ queue with `ffmpeg`-based workers
3. Video processing jobs: transcode to HLS (multiple bitrates) → upload segments to S3 → update `MediaAsset.durationSecs`
4. Use `MediaVariant` to track HLS playlist key and individual bitrate variant keys
5. CloudFront + S3 already supports range requests needed for HLS streaming
6. For live streaming: add a separate pipeline using AWS IVS or Agora — the existing signed URL and access control logic applies unchanged to recorded playback
