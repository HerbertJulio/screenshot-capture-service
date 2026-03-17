import Fastify from 'fastify'
import { apiKeyAuth } from './middleware/auth.js'
import { rateLimitHook } from './middleware/rate-limit.js'
import { registerCaptureRoutes } from './routes/captures.js'
import { registerEntityRoutes } from './routes/entities.js'
import { registerEventRoutes } from './routes/events.js'
import { registerHealthRoutes } from './routes/health.js'
import { BODY_LIMIT_BYTES } from '../config/constants.js'
import type { Container } from '../container.js'

export function createApp(container: Container) {
  const app = Fastify({
    logger: {
      level: container.config.NODE_ENV === 'development' ? 'debug' : 'info',
    },
    trustProxy: true,
    bodyLimit: BODY_LIMIT_BYTES,
  })

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url

    if (path === '/healthz' || path === '/readyz' || path === '/metrics') return
    if (path === '/v1/events') return

    await apiKeyAuth(request, reply)
    if (reply.sent) return

    await rateLimitHook(request, reply)
  })

  registerHealthRoutes(app, container)
  registerCaptureRoutes(app, container)
  registerEntityRoutes(app, container)
  registerEventRoutes(app, container)

  app.setErrorHandler((error, _request, reply) => {
    app.log.error({ err: error }, 'Unhandled error')
    reply.code(500).send({
      error: 'internal_error',
      message: 'An unexpected error occurred',
    })
  })

  return app
}
