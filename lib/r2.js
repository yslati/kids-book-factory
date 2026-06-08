// Cloudflare R2 (S3-compatible) helpers: presigned PUT for the browser upload,
// and a server-side upload for the generated cover. Photo + cover persist here
// so the order keeps permanent URLs (fal's URLs are temporary).

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let client = null;

function getClient() {
  if (client) return client;
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    },
    // AWS SDK v3 adds a default CRC32 checksum to (presigned) PUTs. The signed
    // value is the checksum of empty content, so a real browser upload fails on
    // R2 with a checksum mismatch. Only add checksums when explicitly required.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
  });
  return client;
}

const BUCKET = process.env.R2_BUCKET;
const PUBLIC_BASE = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');

export function r2Configured() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      BUCKET &&
      PUBLIC_BASE
  );
}

export function publicUrl(key) {
  return PUBLIC_BASE + '/' + key;
}

// Presigned PUT the browser uses to upload the child's photo directly to R2.
export async function presignPut(key, contentType) {
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType
  });
  return getSignedUrl(getClient(), cmd, { expiresIn: 600 }); // 10 min
}

// Server-side upload of the generated cover (fetched from fal) into R2.
export async function putObject(key, body, contentType) {
  await getClient().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType
    })
  );
  return publicUrl(key);
}
