import { randomUUID } from 'node:crypto'
import type { EntityType } from '../types.js'
import type { IJobRepository } from '../ports/job-repository.port.js'
import { validateUrl } from '../validators.js'
import { PRIORITY_HIGH, PRIORITY_LOW, DEFAULT_CAPTURE_OPTIONS } from '../../config/constants.js'

export interface BulkCaptureItem {
  url: string
  entityType: EntityType
  entityId: string
}

export interface BulkCaptureResult {
  batchId: string
  totalJobs: number
  skipped: number
}

export class CreateBulkCaptureUseCase {
  constructor(private readonly jobRepo: IJobRepository) {}

  async execute(items: BulkCaptureItem[], priority: 'high' | 'low'): Promise<BulkCaptureResult> {
    const batchId = randomUUID()
    let created = 0

    for (const item of items) {
      const urlCheck = await validateUrl(item.url)
      if (!urlCheck.valid) continue

      const existing = this.jobRepo.findActiveJob(item.entityType, item.entityId)
      if (existing) continue

      this.jobRepo.createJob({
        url: item.url,
        entityType: item.entityType,
        entityId: item.entityId,
        batchId,
        priority: priority === 'low' ? PRIORITY_LOW : PRIORITY_HIGH,
        options: {
          viewports: [...DEFAULT_CAPTURE_OPTIONS.viewports],
          waitStrategy: DEFAULT_CAPTURE_OPTIONS.waitStrategy,
          waitSelector: DEFAULT_CAPTURE_OPTIONS.waitSelector,
          waitTimeoutMs: DEFAULT_CAPTURE_OPTIONS.waitTimeoutMs,
          delayAfterLoadMs: DEFAULT_CAPTURE_OPTIONS.delayAfterLoadMs,
        },
      })
      created++
    }

    return { batchId, totalJobs: created, skipped: items.length - created }
  }
}
