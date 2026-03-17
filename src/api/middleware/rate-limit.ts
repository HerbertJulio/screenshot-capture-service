import type { FastifyRequest, FastifyReply } from 'fastify'
import {
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_PRUNE_INTERVAL_MS,
} from '../../config/constants.js'

interface RateLimitEntry {
  count: number
  resetAt: number
}

const rateLimitMap = new Map<string, RateLimitEntry>()

// Prune expired entries periodically
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key)
  }
}, RATE_LIMIT_PRUNE_INTERVAL_MS).unref()

export async function rateLimitHook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const key = (request.headers['x-api-key'] as string) ?? request.ip
  const now = Date.now()
  const entry = rateLimitMap.get(key)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return
  }

  entry.count++
  if (entry.count > RATE_LIMIT_MAX) {
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
