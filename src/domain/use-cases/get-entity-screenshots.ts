import type { EntityType, ScreenshotRecord } from '../types.js'
import type { IScreenshotRepository } from '../ports/screenshot-repository.port.js'

export interface EntityScreenshotsResult {
  entityType: EntityType
  entityId: string
  latestCaptureAt: string | null
  screenshots: ScreenshotRecord[]
}

export class GetEntityScreenshotsUseCase {
  constructor(private readonly screenshotRepo: IScreenshotRepository) {}

  execute(entityType: EntityType, entityId: string): EntityScreenshotsResult {
    const screenshots = this.screenshotRepo.getLatestScreenshots(entityType, entityId)

    const latestCaptureAt =
      screenshots.length > 0
        ? screenshots.reduce((max, s) => (s.capturedAt > max ? s.capturedAt : max), screenshots[0].capturedAt)
        : null

    return { entityType, entityId, latestCaptureAt, screenshots }
  }
}
