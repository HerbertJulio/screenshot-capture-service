import type { FastifyInstance } from 'fastify'
import { isValidEntityType } from '../../domain/types.js'
import type { EntityType } from '../../domain/types.js'
import type { Container } from '../../container.js'
import { toScreenshotResponse } from '../mappers/screenshot-response.mapper.js'

export function registerEntityRoutes(app: FastifyInstance, container: Container): void {
  const { getEntityScreenshots, deleteEntityScreenshots } = container.useCases

  app.get<{ Params: { entity_type: string; entity_id: string } }>(
    '/v1/entities/:entity_type/:entity_id/screenshots',
    async (request, reply) => {
      const { entity_type, entity_id } = request.params

      if (!isValidEntityType(entity_type)) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'entity_type must be template, application, or deployment',
        })
      }

      const result = getEntityScreenshots.execute(entity_type, entity_id)

      return reply.send({
        entity_type: result.entityType,
        entity_id: result.entityId,
        latest_capture_at: result.latestCaptureAt,
        screenshots: result.screenshots.map(toScreenshotResponse),
      })
    }
  )

  app.delete<{ Params: { entity_type: string; entity_id: string } }>(
    '/v1/entities/:entity_type/:entity_id/screenshots',
    async (request, reply) => {
      const { entity_type, entity_id } = request.params

      if (!isValidEntityType(entity_type)) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'entity_type must be template, application, or deployment',
        })
      }

      await deleteEntityScreenshots.execute(entity_type as EntityType, entity_id)
      return reply.code(204).send()
    }
  )
}
