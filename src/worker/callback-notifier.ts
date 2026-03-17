import { createHmac } from 'node:crypto'
import pino from 'pino'
import type { CaptureJob } from '../domain/types.js'
import { CALLBACK_TIMEOUT_MS } from '../config/constants.js'

const logger = pino({ name: 'callback-notifier' })

export interface CallbackScreenshot {
  viewport: string
  cdnUrl: string
  width: number
  height: number
  format: string
}

export class CallbackNotifier {
  constructor(private readonly webhookSecret: string) {}

  async notify(
    job: CaptureJob,
    screenshots: CallbackScreenshot[],
    errorCode?: string,
    errorMessage?: string,
  ): Promise<void> {
    if (!job.callbackUrl) return

    const payload = {
      event: errorCode ? 'capture.failed' : 'capture.completed',
      job_id: job.id,
      status: errorCode ? 'failed' : 'succeeded',
      entity_type: job.entityType,
      entity_id: job.entityId,
      error: errorCode ? { code: errorCode, message: errorMessage } : undefined,
      screenshots: screenshots.map((s) => ({
        viewport: s.viewport,
        image_url: s.cdnUrl,
        width: s.width,
        height: s.height,
        format: s.format,
      })),
    }

    const body = JSON.stringify(payload)
    const signature = createHmac('sha256', this.webhookSecret).update(body).digest('hex')

    const response = await fetch(job.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    })

    if (!response.ok) {
      logger.warn({ status: response.status, jobId: job.id }, 'Callback returned non-2xx')
    }
  }
}
