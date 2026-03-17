import type { FastifyInstance } from 'fastify'
import { createCaptureSchema, bulkCaptureSchema } from '../../domain/types.js'
import type { ViewportName } from '../../domain/types.js'
import type { Container } from '../../container.js'
import { toJobResponse, toJobCreatedResponse } from '../mappers/job-response.mapper.js'

export function registerCaptureRoutes(app: FastifyInstance, container: Container): void {
  const { createCapture, createBulkCapture, getCaptureStatus } = container.useCases

  app.post('/v1/captures', async (request, reply) => {
    const parsed = createCaptureSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      })
    }

    const input = parsed.data
    const result = await createCapture.execute({
      url: input.url,
      entityType: input.entity_type,
      entityId: input.entity_id,
      callbackUrl: input.callback_url,
      options: {
        viewports: input.options.viewports as ViewportName[],
        waitStrategy: input.options.wait_strategy,
        waitSelector: input.options.wait_selector,
        waitTimeoutMs: input.options.wait_timeout_ms,
        delayAfterLoadMs: input.options.delay_after_load_ms,
      },
    })

    switch (result.type) {
      case 'url_not_allowed':
        return reply.code(403).send({ error: 'url_not_allowed', message: result.reason })
      case 'invalid_callback_url':
        return reply.code(400).send({ error: 'invalid_callback_url', message: result.reason })
      case 'deduplicated':
        return reply.code(202).send(toJobCreatedResponse(result.job, true))
      case 'created':
        return reply.code(202).send(toJobCreatedResponse(result.job))
    }
  })

  app.post('/v1/captures/bulk', async (request, reply) => {
    const parsed = bulkCaptureSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      })
    }

    const { items, priority } = parsed.data
    const result = await createBulkCapture.execute(
      items.map((i) => ({ url: i.url, entityType: i.entity_type, entityId: i.entity_id })),
      priority,
    )

    return reply.code(202).send({
      batch_id: result.batchId,
      total_jobs: result.totalJobs,
      skipped: result.skipped,
      status: 'queued',
    })
  })

  app.get<{ Params: { job_id: string } }>('/v1/captures/:job_id', async (request, reply) => {
    const result = getCaptureStatus.execute(request.params.job_id)
    if (!result) {
      return reply.code(404).send({ error: 'not_found', message: 'Job not found' })
    }

    return reply.send(toJobResponse(result.job, result.screenshots))
  })
}
