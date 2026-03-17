import type { CaptureJob, CaptureOptions, ViewportName } from '../types.js'
import type { IJobRepository } from '../ports/job-repository.port.js'
import { validateUrl, validateCallbackUrl } from '../validators.js'

export interface CreateCaptureInput {
  url: string
  entityType: string
  entityId: string
  callbackUrl?: string
  options: {
    viewports: ViewportName[]
    waitStrategy: 'networkidle' | 'domcontentloaded' | 'load'
    waitSelector?: string
    waitTimeoutMs: number
    delayAfterLoadMs: number
  }
}

export type CreateCaptureResult =
  | { type: 'created'; job: CaptureJob }
  | { type: 'deduplicated'; job: CaptureJob }
  | { type: 'url_not_allowed'; reason: string }
  | { type: 'invalid_callback_url'; reason: string }

export class CreateCaptureUseCase {
  constructor(private readonly jobRepo: IJobRepository) {}

  async execute(input: CreateCaptureInput): Promise<CreateCaptureResult> {
    const urlCheck = await validateUrl(input.url)
    if (!urlCheck.valid) {
      return { type: 'url_not_allowed', reason: urlCheck.reason! }
    }

    if (input.callbackUrl) {
      const callbackCheck = await validateCallbackUrl(input.callbackUrl)
      if (!callbackCheck.valid) {
        return { type: 'invalid_callback_url', reason: callbackCheck.reason! }
      }
    }

    const existing = this.jobRepo.findActiveJob(input.entityType as any, input.entityId)
    if (existing) {
      return { type: 'deduplicated', job: existing }
    }

    const options: CaptureOptions = {
      viewports: input.options.viewports,
      waitStrategy: input.options.waitStrategy,
      waitSelector: input.options.waitSelector ?? null,
      waitTimeoutMs: input.options.waitTimeoutMs,
      delayAfterLoadMs: input.options.delayAfterLoadMs,
    }

    const job = this.jobRepo.createJob({
      url: input.url,
      entityType: input.entityType as any,
      entityId: input.entityId,
      callbackUrl: input.callbackUrl,
      options,
    })

    return { type: 'created', job }
  }
}
