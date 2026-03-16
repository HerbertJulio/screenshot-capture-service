import type { FastifyInstance } from 'fastify'
import {
  getLatestScreenshots,
  deleteScreenshotsByEntity,
} from '../../shared/db/database.js'
import type { EntityType } from '../../shared/types/job.types.js'

export function registerEntityRoutes(app: FastifyInstance): void {
  // GET /v1/entities/:entity_type/:entity_id/screenshots
  app.get<{ Params: { entity_type: string; entity_id: string } }>(
    '/v1/entities/:entity_type/:entity_id/screenshots',
    async (request, reply) => {
      const { entity_type, entity_id } = request.params

      if (!['template', 'application', 'deployment'].includes(entity_type)) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'entity_type must be template, application, or deployment',
        })
      }

      const screenshots = getLatestScreenshots(
        entity_type as EntityType,
        entity_id
      )

      const latestCapturedAt =
        screenshots.length > 0
          ? screenshots.reduce((max, s) =>
              s.capturedAt > max ? s.capturedAt : max, screenshots[0].capturedAt)
          : null

      return reply.send({
        entity_type,
        entity_id,
        latest_capture_at: latestCapturedAt,
        screenshots: screenshots.map((s) => ({
          viewport: s.viewport,
          image_url: s.cdnUrl,
          width: s.width,
          height: s.height,
          format: s.format,
          file_size_bytes: s.fileSizeBytes,
        })),
      })
    }
  )

  // DELETE /v1/entities/:entity_type/:entity_id/screenshots
  app.delete<{ Params: { entity_type: string; entity_id: string } }>(
    '/v1/entities/:entity_type/:entity_id/screenshots',
    async (request, reply) => {
      const { entity_type, entity_id } = request.params

      if (!['template', 'application', 'deployment'].includes(entity_type)) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'entity_type must be template, application, or deployment',
        })
      }

      deleteScreenshotsByEntity(entity_type as EntityType, entity_id)
      return reply.code(204).send()
    }
  )
}
