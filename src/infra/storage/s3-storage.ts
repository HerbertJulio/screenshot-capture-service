import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import pino from 'pino'
import type { IStorageProvider } from '../../domain/ports/storage.port.js'

const logger = pino({ name: 'storage:s3' })

export class S3StorageProvider implements IStorageProvider {
  private client: S3Client
  private bucket: string
  private cdnBaseUrl: string

  constructor(opts: {
    endpoint: string
    region: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
    cdnBaseUrl: string
  }) {
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
      forcePathStyle: true,
    })
    this.bucket = opts.bucket
    this.cdnBaseUrl = opts.cdnBaseUrl
  }

  async upload(key: string, buffer: Buffer, contentType: string): Promise<void> {
    const start = Date.now()
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      })
    )
    logger.info({ key, ms: Date.now() - start, bytes: buffer.byteLength }, 'Uploaded to S3')
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
    )
    logger.info({ key }, 'Deleted from S3')
  }

  buildUrl(key: string): string {
    return `${this.cdnBaseUrl}/${key}`
  }
}
