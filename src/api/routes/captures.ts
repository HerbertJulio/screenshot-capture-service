import type { FastifyInstance } from 'fastify'
import { createCaptureSchema, bulkCaptureSchema } from '../../shared/types/api.types.js'
import { validateUrl } from '../../shared/security/url-validator.js'
import {
  createJob,
  findActiveJob,
  getJobById,
  getScreenshotsByJobId,
} from '../../shared/db/database.js'
import { randomUUID } from 'node:crypto'
import type { CaptureOptions, ViewportName } from '../../shared/types/job.types.js'

export function registerCaptureRoutes(app: FastifyInstance): void {
  // POST /v1/captures
  app.post('/v1/captures', async (request, reply) => {
    const parsed = createCaptureSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      })
    }

    const input = parsed.data
    const urlCheck = await validateUrl(input.url)
    if (!urlCheck.valid) {
      return reply.code(403).send({
        error: 'url_not_allowed',
        message: urlCheck.reason,
      })
    }

    // Deduplication
    const existing = findActiveJob(input.entity_type, input.entity_id)
    if (existing) {
      return reply.code(202).send({
        job_id: existing.id,
        status: existing.status,
        created_at: existing.createdAt,
        estimated_completion_seconds: 30,
        deduplicated: true,
      })
    }

    const options: CaptureOptions = {
      viewports: input.options.viewports as ViewportName[],
      waitStrategy: input.options.wait_strategy,
      waitSelector: input.options.wait_selector ?? null,
      waitTimeoutMs: input.options.wait_timeout_ms,
      delayAfterLoadMs: input.options.delay_after_load_ms,
    }

    const job = createJob({
      url: input.url,
      entityType: input.entity_type,
      entityId: input.entity_id,
      callbackUrl: input.callback_url,
      options,
    })

    return reply.code(202).send({
      job_id: job.id,
      status: job.status,
      created_at: job.createdAt,
      estimated_completion_seconds: 30,
    })
  })

  // POST /v1/captures/bulk
  app.post('/v1/captures/bulk', async (request, reply) => {
    const parsed = bulkCaptureSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      })
    }

    const { items, priority } = parsed.data
    const batchId = randomUUID()
    let created = 0

    for (const item of items) {
      const urlCheck = await validateUrl(item.url)
      if (!urlCheck.valid) continue

      const existing = findActiveJob(item.entity_type, item.entity_id)
      if (existing) continue

      createJob({
        url: item.url,
        entityType: item.entity_type,
        entityId: item.entity_id,
        batchId,
        priority: priority === 'low' ? 8 : 3,
        options: {
          viewports: ['card'],
          waitStrategy: 'networkidle',
          waitSelector: null,
          waitTimeoutMs: 15_000,
          delayAfterLoadMs: 2000,
        },
      })
      created++
    }

    return reply.code(202).send({
      batch_id: batchId,
      total_jobs: created,
      skipped: items.length - created,
      status: 'queued',
    })
  })

  // GET /v1/captures/:job_id
  app.get<{ Params: { job_id: string } }>('/v1/captures/:job_id', async (request, reply) => {
    const job = getJobById(request.params.job_id)
    if (!job) {
      return reply.code(404).send({ error: 'not_found', message: 'Job not found' })
    }

    const screenshots = getScreenshotsByJobId(job.id)

    return reply.send({
      job_id: job.id,
      status: job.status,
      url: job.url,
      entity_type: job.entityType,
      entity_id: job.entityId,
      attempts: job.attempts,
      created_at: job.createdAt,
      started_at: job.startedAt,
      completed_at: job.completedAt,
      error: job.errorCode
        ? { code: job.errorCode, message: job.errorMessage }
        : undefined,
      results: screenshots.map((s) => ({
        viewport: s.viewport,
        width: s.width,
        height: s.height,
        format: s.format,
        image_url: s.cdnUrl,
        file_size_bytes: s.fileSizeBytes,
      })),
    })
  })
}
