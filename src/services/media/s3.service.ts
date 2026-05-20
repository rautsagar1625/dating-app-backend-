// ── S3 service ────────────────────────────────────────────────────────────────
//
// Thin wrapper over the AWS SDK v3 client. All media services funnel through
// here so we can swap to MinIO/LocalStack in dev by setting S3_ENDPOINT.
//
// Bucket policies (configured outside this code in Terraform/CDK):
//   - velvet-media-temp:      s3:PutObject for the app IAM role; no public access
//   - velvet-media-public:    s3:GetObject for CloudFront OAC; no public s3 access
//   - velvet-media-private:   s3:GetObject for CloudFront OAC only; signed URLs only
//   - velvet-media-chat:      same as private
//   - velvet-media-quarantine: only admin IAM role; no CloudFront distribution

import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';

export const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'ap-south-1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID     ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  },
  // MinIO/LocalStack for local dev: set S3_ENDPOINT=http://localhost:9000
  ...(process.env.S3_ENDPOINT
    ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }
    : {}),
});

export const PRESIGN_UPLOAD_TTL_SECS = 900; // 15 minutes

// Create a short-lived presigned PUT URL for direct client-to-S3 upload.
// The Content-Type condition forces the client to upload with the correct MIME,
// which S3 then stores in metadata — visible later via HeadObject.
export async function createPresignedPutUrl(params: {
  bucket:      string;
  key:         string;
  mimeType:    string;
  expiresIn?:  number;
}): Promise<string> {
  const command = new PutObjectCommand({
    Bucket:      params.bucket,
    Key:         params.key,
    ContentType: params.mimeType,
  });
  return awsGetSignedUrl(s3, command, {
    expiresIn: params.expiresIn ?? PRESIGN_UPLOAD_TTL_SECS,
  });
}

export interface S3HeadResult {
  exists:        boolean;
  contentLength: number;
  contentType:   string;
  etag:          string;
}

// HeadObject — confirm a file exists without downloading it.
export async function headObject(bucket: string, key: string): Promise<S3HeadResult> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      exists:        true,
      contentLength: res.ContentLength  ?? 0,
      contentType:   res.ContentType    ?? '',
      etag:          res.ETag           ?? '',
    };
  } catch (err: any) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return { exists: false, contentLength: 0, contentType: '', etag: '' };
    }
    throw err;
  }
}

// Server-side copy — used to move processed objects from temp → final bucket.
// S3 server-side copy avoids any data traversing the app server.
export async function copyObject(
  sourceBucket: string,
  sourceKey:    string,
  destBucket:   string,
  destKey:      string,
  cacheControl?: string,
): Promise<void> {
  await s3.send(new CopyObjectCommand({
    CopySource:   `${sourceBucket}/${encodeURIComponent(sourceKey)}`,
    Bucket:       destBucket,
    Key:          destKey,
    ...(cacheControl ? { CacheControl: cacheControl } : {}),
  }));
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {});
}

// Batch delete up to 1000 keys in one request.
export async function deleteObjects(bucket: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await s3.send(new DeleteObjectsCommand({
    Bucket: bucket,
    Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
  }));
}

// Download an object into a Buffer. Used by image processor to read from temp bucket.
// Streams the body to avoid memory spikes on large files.
export async function getObjectBuffer(bucket: string, key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`S3 object ${bucket}/${key} has no body`);

  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Upload a Buffer to S3 — used by the image processor for processed variants.
export async function putObject(params: {
  bucket:       string;
  key:          string;
  body:         Buffer;
  contentType:  string;
  cacheControl?: string;
}): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket:       params.bucket,
    Key:          params.key,
    Body:         params.body,
    ContentType:  params.contentType,
    ...(params.cacheControl ? { CacheControl: params.cacheControl } : {}),
  }));
}
