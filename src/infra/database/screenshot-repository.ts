import { randomUUID } from 'node:crypto'
import { getDb, stmt } from './connection.js'
import type {
  EntityType,
  ImageFormat,
  ScreenshotRecord,
  ViewportName,
} from '../../domain/types.js'
import type { IScreenshotRepository, InsertScreenshotParams } from '../../domain/ports/screenshot-repository.port.js'

// -- Raw DB row --

interface RawScreenshot {
  id: string
  job_id: string
  entity_type: string
  entity_id: string
  viewport: string
  width: number
  height: number
  format: string
  storage_key: string
  cdn_url: string
  file_size_bytes: number | null
  is_latest: number
  captured_at: string
}

function mapScreenshot(row: RawScreenshot): ScreenshotRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    entityType: row.entity_type as EntityType,
    entityId: row.entity_id,
    viewport: row.viewport as ViewportName,
    width: row.width,
    height: row.height,
    format: row.format as ImageFormat,
    storageKey: row.storage_key,
    cdnUrl: row.cdn_url,
    fileSizeBytes: row.file_size_bytes,
    isLatest: row.is_latest === 1,
    capturedAt: row.captured_at,
  }
}

export class ScreenshotRepository implements IScreenshotRepository {
  insertScreenshot(params: InsertScreenshotParams): ScreenshotRecord {
    const id = randomUUID()

    getDb().transaction(() => {
      stmt(
        'unsetLatest',
        `UPDATE screenshots SET is_latest = 0
         WHERE entity_type = ? AND entity_id = ? AND viewport = ? AND format = ? AND is_latest = 1`
      ).run(params.entityType, params.entityId, params.viewport, params.format)

      stmt(
        'insertSS',
        `INSERT INTO screenshots (id, job_id, entity_type, entity_id, viewport, width, height, format, storage_key, cdn_url, file_size_bytes, is_latest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(
        id,
        params.jobId,
        params.entityType,
        params.entityId,
        params.viewport,
        params.width,
        params.height,
        params.format,
        params.storageKey,
        params.cdnUrl,
        params.fileSizeBytes
      )
    })()

    return this.getScreenshotsByJobId(params.jobId).find((s) => s.id === id)!
  }

  getLatestScreenshots(entityType: EntityType, entityId: string): ScreenshotRecord[] {
    const rows = stmt(
      'getLatest',
      `SELECT * FROM screenshots WHERE entity_type = ? AND entity_id = ? AND is_latest = 1 ORDER BY viewport`
    ).all(entityType, entityId) as RawScreenshot[]
    return rows.map(mapScreenshot)
  }

  getScreenshotsByJobId(jobId: string): ScreenshotRecord[] {
    const rows = stmt('getByJob', 'SELECT * FROM screenshots WHERE job_id = ?').all(jobId) as RawScreenshot[]
    return rows.map(mapScreenshot)
  }

  deleteScreenshotsByEntity(entityType: EntityType, entityId: string): number {
    const result = stmt(
      'deleteSS',
      'DELETE FROM screenshots WHERE entity_type = ? AND entity_id = ?'
    ).run(entityType, entityId)
    return result.changes
  }
}
