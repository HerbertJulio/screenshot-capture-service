import type { FastifyInstance } from 'fastify'
import { webhookEventSchema } from '../../shared/types/api.types.js'
import { verifyWebhookSignature } from '../middleware/auth.js'
import { validateUrl } from '../../shared/security/url-validator.js'
import { createJob, findActiveJob } from '../../shared/db/database.js'
import type { CaptureOptions } from '../../shared/types/job.types.js'
import type { ViewportName } from '../../shared/config.js'

export function registerEventRoutes(app: FastifyInstance): void {
  // POST /v1/events — webhook receiver
  app.post('/v1/events', async (request, reply) => {
    // Verify webhook signature
    const signature = request.headers['x-webhook-signature'] as string | undefined
    if (!signature) {
      return reply.code(401).send({
        error: 'unauthorized',
        message: 'Missing X-Webhook-Signature header',
      })
    }

    const rawBody =
      typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body)

    if (!verifyWebhookSignature(rawBody, signature)) {
      return reply.code(401).send({
        error: 'unauthorized',
        message: 'Invalid webhook signature',
      })
    }

    const parsed = webhookEventSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      })
    }

    const event = parsed.data
    const urlCheck = await validateUrl(event.url)
    if (!urlCheck.valid) {
      return reply.code(403).send({
        error: 'url_not_allowed',
        message: urlCheck.reason,
      })
    }

    // Deduplication
    const existing = findActiveJob(event.entity_type, event.entity_id)
    if (existing) {
      return reply.code(202).send({
        job_id: existing.id,
        status: existing.status,
        created_at: existing.createdAt,
        deduplicated: true,
      })
    }

    const viewports: ViewportName[] =
      event.event_type === 'template.published' || event.event_type === 'template.updated'
        ? ['card', 'detail']
        : ['card']

    const options: CaptureOptions = {
      viewports,
      waitStrategy: 'networkidle',
      waitSelector: null,
      waitTimeoutMs: 15_000,
      delayAfterLoadMs: 2000,
    }

    const job = createJob({
      url: event.url,
      entityType: event.entity_type,
      entityId: event.entity_id,
      options,
      priority: 3, // high priority for events
    })

    return reply.code(202).send({
      job_id: job.id,
      status: job.status,
      created_at: job.createdAt,
    })
  })
}
