import Fastify from 'fastify'
import { apiKeyAuth } from './middleware/auth.js'
import { registerCaptureRoutes } from './routes/captures.js'
import { registerEntityRoutes } from './routes/entities.js'
import { registerEventRoutes } from './routes/events.js'
import { registerHealthRoutes } from './routes/health.js'

export function createApp() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
    },
    trustProxy: true,
    bodyLimit: 1_048_576, // 1MB
  })

  // Rate limiting state (simple in-memory)
  const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
  const RATE_LIMIT = 60
  const RATE_WINDOW_MS = 60_000

  // Prune expired entries every 5 minutes
  setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(key)
    }
  }, 5 * 60_000).unref()

  // Auth + rate limit for API routes
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url

    // Skip auth for health endpoints
    if (path === '/healthz' || path === '/readyz' || path === '/metrics') {
      return
    }

    // Skip API key auth for webhook events (uses signature)
    if (path === '/v1/events') {
      return
    }

    // API key auth
    await apiKeyAuth(request, reply)
    if (reply.sent) return

    // Simple rate limiting
    const key = (request.headers['x-api-key'] as string) ?? request.ip
    const now = Date.now()
    const entry = rateLimitMap.get(key)

    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS })
    } else {
      entry.count++
      if (entry.count > RATE_LIMIT) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000)
        return reply
          .code(429)
          .header('Retry-After', retryAfter)
          .send({
            error: 'rate_limit_exceeded',
            message: `Too many requests. Retry after ${retryAfter} seconds.`,
          })
      }
    }
  })

  // Register routes
  registerHealthRoutes(app)
  registerCaptureRoutes(app)
  registerEntityRoutes(app)
  registerEventRoutes(app)

  // Global error handler
  app.setErrorHandler((error, _request, reply) => {
    app.log.error({ err: error }, 'Unhandled error')
    reply.code(500).send({
      error: 'internal_error',
      message: 'An unexpected error occurred',
    })
  })

  return app
}
