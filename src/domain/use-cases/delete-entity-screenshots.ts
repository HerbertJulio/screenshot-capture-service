import type { EntityType } from '../types.js'
import type { IScreenshotRepository } from '../ports/screenshot-repository.port.js'
import type { IStorageProvider } from '../ports/storage.port.js'
import pino from 'pino'

const logger = pino({ name: 'use-case:delete-screenshots' })

export class DeleteEntityScreenshotsUseCase {
  constructor(
    private readonly screenshotRepo: IScreenshotRepository,
    private readonly storage: IStorageProvider,
  ) {}

  async execute(entityType: EntityType, entityId: string): Promise<number> {
    const screenshots = this.screenshotRepo.getLatestScreenshots(entityType, entityId)

    for (const screenshot of screenshots) {
      try {
        await this.storage.delete(screenshot.storageKey)
      } catch (err) {
        logger.warn({ err, storageKey: screenshot.storageKey }, 'Failed to delete storage file')
      }
    }

    return this.screenshotRepo.deleteScreenshotsByEntity(entityType, entityId)
  }
}
