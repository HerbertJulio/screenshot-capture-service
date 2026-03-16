import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import pino from 'pino'
import { getConfig } from '../shared/config.js'
import type { EntityType, ViewportName, ImageFormat } from '../shared/types/job.types.js'

const logger = pino({ name: 'storage-uploader' })

let s3: S3Client | null = null
let useLocalStorage = false

function getS3(): S3Client {
  if (!s3) {
    const config = getConfig()
    if (!config.S3_ENDPOINT || !config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY) {
      throw new Error('S3 credentials not configured. Set USE_LOCAL_STORAGE=true for local dev.')
    }
    s3 = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
    })
  }
  return s3
}

const LOCAL_STORAGE_DIR = './data/screenshots'

export function buildStorageKey(
  entityType: EntityType,
  entityId: string,
  viewport: ViewportName,
  width: number,
  height: number,
  format: ImageFormat
): string {
  const timestamp = Math.floor(Date.now() / 1000)
  return `screenshots/${entityType}/${entityId}/${viewport}-${width}x${height}-v${timestamp}.${format}`
}

export function buildCdnUrl(storageKey: string): string {
  if (useLocalStorage) {
    return `file://${join(process.cwd(), LOCAL_STORAGE_DIR, storageKey)}`
  }
  const config = getConfig()
  return `${config.CDN_BASE_URL}/${storageKey}`
}

export function enableLocalStorage(): void {
  useLocalStorage = true
  logger.info({ dir: LOCAL_STORAGE_DIR }, 'Local filesystem storage enabled')
}

export async function uploadScreenshot(
  storageKey: string,
  buffer: Buffer,
  format: ImageFormat
): Promise<void> {
  const startTime = Date.now()

  if (useLocalStorage) {
    const filePath = join(LOCAL_STORAGE_DIR, storageKey)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, buffer)
    const durationMs = Date.now() - startTime
    logger.info({ storageKey, durationMs, sizeBytes: buffer.byteLength }, 'Saved to local disk')
    return
  }

  const config = getConfig()
  const contentType = format === 'webp' ? 'image/webp' : 'image/png'

  await getS3().send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: storageKey,
      Body: buffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    })
  )

  const durationMs = Date.now() - startTime
  logger.info({ storageKey, durationMs, sizeBytes: buffer.byteLength }, 'Upload completed')
}

export async function deleteScreenshot(storageKey: string): Promise<void> {
  if (useLocalStorage) {
    const filePath = join(LOCAL_STORAGE_DIR, storageKey)
    try {
      unlinkSync(filePath)
      logger.info({ storageKey }, 'File deleted from local disk')
    } catch {
      logger.warn({ storageKey }, 'File not found on local disk')
    }
    return
  }

  const config = getConfig()

  await getS3().send(
    new DeleteObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: storageKey,
    })
  )

  logger.info({ storageKey }, 'File deleted from storage')
}
