import type { EntityType, ImageFormat, ScreenshotRecord, ViewportName } from '../types.js'

export interface InsertScreenshotParams {
  jobId: string
  entityType: EntityType
  entityId: string
  viewport: ViewportName
  width: number
  height: number
  format: ImageFormat
  storageKey: string
  cdnUrl: string
  fileSizeBytes: number
}

export interface IScreenshotRepository {
  insertScreenshot(params: InsertScreenshotParams): ScreenshotRecord
  getLatestScreenshots(entityType: EntityType, entityId: string): ScreenshotRecord[]
  getScreenshotsByJobId(jobId: string): ScreenshotRecord[]
  deleteScreenshotsByEntity(entityType: EntityType, entityId: string): number
}
