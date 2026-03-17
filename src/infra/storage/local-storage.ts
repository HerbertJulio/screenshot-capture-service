import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import pino from 'pino'
import type { IStorageProvider } from '../../domain/ports/storage.port.js'

const logger = pino({ name: 'storage:local' })

export class LocalStorageProvider implements IStorageProvider {
  private baseDir: string

  constructor(baseDir: string = './data/screenshots') {
    this.baseDir = baseDir
    logger.info({ dir: baseDir }, 'Local filesystem storage enabled')
  }

  async upload(key: string, buffer: Buffer): Promise<void> {
    const start = Date.now()
    const filePath = join(this.baseDir, key)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, buffer)
    logger.info({ key, ms: Date.now() - start, bytes: buffer.byteLength }, 'Saved to disk')
  }

  async delete(key: string): Promise<void> {
    const filePath = join(this.baseDir, key)
    try {
      unlinkSync(filePath)
      logger.info({ key }, 'Deleted from disk')
    } catch {
      logger.warn({ key }, 'File not found on disk')
    }
  }

  buildUrl(key: string): string {
    return `file://${join(process.cwd(), this.baseDir, key)}`
  }
}
