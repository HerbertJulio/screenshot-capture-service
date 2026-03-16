import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { getConfig } from '../../shared/config.js'

export async function apiKeyAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const apiKey = request.headers['x-api-key']
  if (!apiKey || apiKey !== getConfig().API_KEY) {
    reply.code(401).send({ error: 'unauthorized', message: 'Invalid or missing API key' })
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
