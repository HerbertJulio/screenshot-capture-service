import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { getConfig } from '../../shared/config.js'

export async function apiKeyAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const apiKey = request.headers['x-api-key']
  if (!apiKey || typeof apiKey !== 'string') {
    return reply.code(401).send({ error: 'unauthorized', message: 'Missing API key' })
  }

  const expected = getConfig().API_KEY
  const apiKeyBuf = Buffer.from(apiKey)
  const expectedBuf = Buffer.from(expected)

  if (apiKeyBuf.length !== expectedBuf.length || !timingSafeEqual(apiKeyBuf, expectedBuf)) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Invalid API key' })
  }
}

export function verifyWebhookSignature(body: string, signature: string): boolean {
  const config = getConfig()
  const expected = createHmac('sha256', config.WEBHOOK_SECRET)
    .update(body)
    .digest('hex')

  try {
    return timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    )
  } catch {
    return false
  }
}
