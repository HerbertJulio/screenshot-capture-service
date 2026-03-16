import type { FastifyInstance } from 'fastify'
import { getDb, getJobCountByStatus } from '../../shared/db/database.js'

export function registerHealthRoutes(app: FastifyInstance): void {
  // GET /healthz
  app.get('/healthz', async () => {
    return { status: 'ok' }
  })

  // GET /readyz
  app.get('/readyz', async (_request, reply) => {
    try {
      getDb().prepare('SELECT 1').get()
      return { status: 'ok', db: 'connected' }
    } catch {
      reply.code(503)
      return { status: 'degraded', db: 'disconnected' }
    }
  })

  // GET /metrics
  app.get('/metrics', async (_request, reply) => {
    const counts = getJobCountByStatus()
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
