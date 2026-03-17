import type { CaptureJob, CaptureOptions, EntityType, ViewportName } from '../types.js'
import type { IJobRepository } from '../ports/job-repository.port.js'
import { validateUrl } from '../validators.js'
import { PRIORITY_HIGH, DEFAULT_CAPTURE_OPTIONS } from '../../config/constants.js'

export interface WebhookEventInput {
  eventType: string
  entityType: EntityType
  entityId: string
  url: string
}

export type WebhookEventResult =
  | { type: 'created'; job: CaptureJob }
  | { type: 'deduplicated'; job: CaptureJob }
  | { type: 'url_not_allowed'; reason: string }

export class ProcessWebhookEventUseCase {
  constructor(private readonly jobRepo: IJobRepository) {}

  async execute(input: WebhookEventInput): Promise<WebhookEventResult> {
    const urlCheck = await validateUrl(input.url)
    if (!urlCheck.valid) {
      return { type: 'url_not_allowed', reason: urlCheck.reason! }
    }

    const existing = this.jobRepo.findActiveJob(input.entityType, input.entityId)
    if (existing) {
      return { type: 'deduplicated', job: existing }
    }

    const viewports: ViewportName[] =
      input.eventType === 'template.published' || input.eventType === 'template.updated'
        ? ['card', 'detail']
        : ['card']

    const options: CaptureOptions = {
      viewports,
      waitStrategy: DEFAULT_CAPTURE_OPTIONS.waitStrategy,
      waitSelector: DEFAULT_CAPTURE_OPTIONS.waitSelector,
      waitTimeoutMs: DEFAULT_CAPTURE_OPTIONS.waitTimeoutMs,
      delayAfterLoadMs: DEFAULT_CAPTURE_OPTIONS.delayAfterLoadMs,
    }

    const job = this.jobRepo.createJob({
      url: input.url,
      entityType: input.entityType,
      entityId: input.entityId,
      options,
      priority: PRIORITY_HIGH,
    })

    return { type: 'created', job }
  }
}
