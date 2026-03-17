import type { FastifyInstance } from 'fastify'
import { webhookEventSchema } from '../../domain/types.js'
import { verifyWebhookSignature } from '../middleware/auth.js'
import type { Container } from '../../container.js'
import { toJobCreatedResponse } from '../mappers/job-response.mapper.js'

export function registerEventRoutes(app: FastifyInstance, container: Container): void {
  const { processWebhookEvent } = container.useCases

  app.post('/v1/events', async (request, reply) => {
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
    const result = await processWebhookEvent.execute({
      eventType: event.event_type,
      entityType: event.entity_type,
      entityId: event.entity_id,
      url: event.url,
    })

    switch (result.type) {
      case 'url_not_allowed':
        return reply.code(403).send({ error: 'url_not_allowed', message: result.reason })
      case 'deduplicated':
        return reply.code(202).send(toJobCreatedResponse(result.job, true))
      case 'created':
        return reply.code(202).send(toJobCreatedResponse(result.job))
    }
  })
}
