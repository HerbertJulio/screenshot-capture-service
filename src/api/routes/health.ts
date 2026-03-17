import type { FastifyInstance } from 'fastify'
import { getDb } from '../../infra/database/connection.js'
import type { Container } from '../../container.js'

export function registerHealthRoutes(app: FastifyInstance, container: Container): void {
  const { jobRepo } = container

  app.get('/healthz', async () => {
    return { status: 'ok' }
  })

  app.get('/readyz', async (_request, reply) => {
    try {
      getDb().prepare('SELECT 1').get()
      return { status: 'ok', db: 'connected' }
    } catch {
      reply.code(503)
      return { status: 'degraded', db: 'disconnected' }
    }
  })

  app.get('/metrics', async (_request, reply) => {
    const counts = jobRepo.getJobCountByStatus()
    const lines: string[] = [
      '# HELP scs_jobs_total Total capture jobs by status',
      '# TYPE scs_jobs_total gauge',
    ]

    for (const [status, count] of Object.entries(counts)) {
      lines.push(`scs_jobs_total{status="${status}"} ${count}`)
    }

    reply.type('text/plain').send(lines.join('\n') + '\n')
  })
}
