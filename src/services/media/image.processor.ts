// ── Image processing pipeline ─────────────────────────────────────────────────
//
// Powered by sharp (libvips), which is 4–5× faster than ImageMagick and
// keeps memory usage flat via streaming pipelines.
//
// Per image, this module produces:
//   • 4 size classes × 2 formats = 8 WebP/AVIF variants
//   • 1 ORIGINAL JPEG (universal client compatibility fallback)
//   • Blurhash  — 4×3 component, ~30 bytes, sent inline with the API response
//                 for progressive loading before the image arrives
//   • pHash     — 64-bit average hash for near-duplicate detection
//   • SHA-256   — integrity check and dedup sentinel
//
// All EXIF data is stripped on ingest (privacy). Orientation is corrected
// before stripping so images display correctly on all clients.

import sharp from 'sharp';
import { encode as encodeBlurhash } from 'blurhash';
import crypto from 'crypto';
import { IMAGE_VARIANT_DEFS, IMAGE_OUTPUT_FORMATS, type VariantType, type ImageFormat } from './media.types';

export interface ProcessedVariant {
  buffer:       Buffer;
  variantType:  VariantType;
  format:       ImageFormat;
  width:        number;
  height:       number;
  fileSizeBytes: number;
}

export interface ProcessingResult {
  variants:       ProcessedVariant[];
  blurhash:       string;
  perceptualHash: string;
  sha256Hash:     string;
  originalWidth:  number;
  originalHeight: number;
}

const WEBP_QUALITY = 82;   // good balance — ~30% smaller than JPEG at same quality
const AVIF_QUALITY = 70;   // AVIF encoder is slower but produces smaller files
const JPEG_QUALITY = 88;   // fallback ORIGINAL — progressive for fast first paint
const BLURHASH_X_COMPONENTS = 4;
const BLURHASH_Y_COMPONENTS = 3;

export async function processImage(inputBuffer: Buffer): Promise<ProcessingResult> {
  const sha256Hash = crypto.createHash('sha256').update(inputBuffer).digest('hex');

  // 1. Auto-orient (fix EXIF rotation) then strip ALL EXIF.
  //    Using two steps because withMetadata({exif:{}}) keeps the IFD0 block
  //    while rotate() reads EXIF rotation before the strip pass.
  // sharp strips all EXIF/metadata by default; .rotate() applies EXIF orientation
  // before the strip, so images display correctly on all clients.
  const oriented = await sharp(inputBuffer)
    .rotate()
    .toBuffer();

  const meta = await sharp(oriented).metadata();
  const originalWidth  = meta.width  ?? 0;
  const originalHeight = meta.height ?? 0;

  // 2. Blurhash — resize to tiny image first to keep encode() fast.
  const { data: rawPixels, info: rawInfo } = await sharp(oriented)
    .resize(32, 32, { fit: 'inside', withoutEnlargement: false })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const blurhash = encodeBlurhash(
    new Uint8ClampedArray(rawPixels),
    rawInfo.width,
    rawInfo.height,
    BLURHASH_X_COMPONENTS,
    BLURHASH_Y_COMPONENTS,
  );

  // 3. Perceptual hash (average hash — 8×8 grayscale → 16 hex chars).
  //    Hamming distance ≤ 10 on 64-bit hashes typically indicates near-duplicates.
  const perceptualHash = await computeAverageHash(oriented);

  // 4. Generate all size × format combinations.
  const variants: ProcessedVariant[] = [];

  for (const def of IMAGE_VARIANT_DEFS) {
    const resized = sharp(oriented).resize(def.width, def.height, {
      fit:               def.fit,
      withoutEnlargement: true,
      fastShrinkOnLoad:  true,
    });

    for (const format of IMAGE_OUTPUT_FORMATS) {
      const processed =
        format === 'WEBP'
          ? await resized.clone().webp({ quality: WEBP_QUALITY, effort: 4, smartSubsample: true }).toBuffer({ resolveWithObject: true })
          : await resized.clone().avif({ quality: AVIF_QUALITY, effort: 3 }).toBuffer({ resolveWithObject: true });

      variants.push({
        buffer:        processed.data,
        variantType:   def.type,
        format,
        width:         processed.info.width,
        height:        processed.info.height,
        fileSizeBytes: processed.data.length,
      });
    }
  }

  // 5. ORIGINAL JPEG — maximum compatibility (older iOS, WeChat browser, etc.).
  //    Progressive encoding enables fast first-paint on slow connections.
  const originalResult = await sharp(oriented)
    .jpeg({ quality: JPEG_QUALITY, progressive: true, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  variants.push({
    buffer:        originalResult.data,
    variantType:   'ORIGINAL',
    format:        'JPEG',
    width:         originalResult.info.width,
    height:        originalResult.info.height,
    fileSizeBytes: originalResult.data.length,
  });

  return { variants, blurhash, perceptualHash, sha256Hash, originalWidth, originalHeight };
}

// ── Perceptual hash helpers ───────────────────────────────────────────────────

async function computeAverageHash(buffer: Buffer): Promise<string> {
  const { data } = await sharp(buffer)
    .resize(8, 8, { fit: 'fill', kernel: 'nearest' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels  = Array.from(data);
  const avg     = pixels.reduce((a, b) => a + b, 0) / pixels.length;
  const bitStr  = pixels.map((p) => (p >= avg ? '1' : '0')).join('');

  // Convert 64-bit string to 16-char hex
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bitStr.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

// Hamming distance between two 16-char hex hashes.
// A distance ≤ 10 usually indicates a near-duplicate or resized copy.
export function hammingDistance(h1: string, h2: string): number {
  if (h1.length !== h2.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < h1.length; i++) {
    let xor = parseInt(h1[i], 16) ^ parseInt(h2[i], 16);
    while (xor) { dist += xor & 1; xor >>= 1; }
  }
  return dist;
}
