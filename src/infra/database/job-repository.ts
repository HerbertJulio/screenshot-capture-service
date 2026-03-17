import { randomUUID } from 'node:crypto'
import { getDb, stmt } from './connection.js'
import type {
  CaptureJob,
  EntityType,
  ErrorCode,
  JobStatus,
} from '../../domain/types.js'
import type { IJobRepository, CreateJobParams, UpdateStatusExtra } from '../../domain/ports/job-repository.port.js'

// -- Raw DB row --

interface RawJob {
  id: string
  url: string
  entity_type: string
  entity_id: string
  status: string
  priority: number
  attempts: number
  max_attempts: number
  options: string
  callback_url: string | null
  batch_id: string | null
  error_message: string | null
  error_code: string | null
  worker_id: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  next_retry_at: string | null
}

function mapJob(row: RawJob): CaptureJob {
  return {
    id: row.id,
    url: row.url,
    entityType: row.entity_type as EntityType,
    entityId: row.entity_id,
    status: row.status as JobStatus,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    options: JSON.parse(row.options),
    callbackUrl: row.callback_url,
    batchId: row.batch_id,
    errorMessage: row.error_message,
    errorCode: row.error_code as ErrorCode | null,
    workerId: row.worker_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    nextRetryAt: row.next_retry_at,
  }
}

export class JobRepository implements IJobRepository {
  createJob(params: CreateJobParams): CaptureJob {
    const id = randomUUID()
    stmt(
      'insertJob',
      `INSERT INTO capture_jobs (id, url, entity_type, entity_id, options, callback_url, batch_id, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.url,
      params.entityType,
      params.entityId,
      JSON.stringify(params.options),
      params.callbackUrl ?? null,
      params.batchId ?? null,
      params.priority ?? 5
    )
    return this.getJobById(id)!
  }

  findActiveJob(entityType: EntityType, entityId: string): CaptureJob | null {
    const row = stmt(
      'findActive',
      `SELECT * FROM capture_jobs WHERE entity_type = ? AND entity_id = ? AND status IN ('queued','running') LIMIT 1`
    ).get(entityType, entityId) as RawJob | undefined
    return row ? mapJob(row) : null
  }

  getJobById(id: string): CaptureJob | null {
    const row = stmt('getJob', 'SELECT * FROM capture_jobs WHERE id = ?').get(id) as RawJob | undefined
    return row ? mapJob(row) : null
  }

  claimNextJob(workerId: string): CaptureJob | null {
    const now = new Date().toISOString()
    const row = stmt(
      'claimJob',
      `UPDATE capture_jobs
       SET status = 'running', worker_id = ?, started_at = ?, attempts = attempts + 1
       WHERE id = (
         SELECT id FROM capture_jobs
         WHERE status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY priority ASC, created_at ASC
         LIMIT 1
       )
       RETURNING *`
    ).get(workerId, now, now) as RawJob | undefined
    return row ? mapJob(row) : null
  }

  updateJobStatus(id: string, status: JobStatus, extra?: UpdateStatusExtra): void {
    const now = new Date().toISOString()
    const completedAt = ['succeeded', 'failed', 'cancelled'].includes(status) ? now : null

    if (status === 'queued' && extra?.nextRetryAt) {
      stmt(
        'requeueJob',
        `UPDATE capture_jobs SET status = ?, next_retry_at = ?, error_code = ?, error_message = ?, completed_at = NULL, worker_id = NULL, started_at = NULL WHERE id = ?`
      ).run(status, extra.nextRetryAt, extra.errorCode ?? null, extra.errorMessage ?? null, id)
    } else {
      stmt(
        'updateStatus',
        `UPDATE capture_jobs SET status = ?, completed_at = ?, error_code = ?, error_message = ? WHERE id = ?`
      ).run(status, completedAt, extra?.errorCode ?? null, extra?.errorMessage ?? null, id)
    }
  }

  recoverStaleJobs(timeoutMinutes: number = 5): number {
    const cutoff = new Date(Date.now() - timeoutMinutes * 60_000).toISOString()
    const result = stmt(
      'recoverStale',
      `UPDATE capture_jobs
       SET status = 'queued', worker_id = NULL, started_at = NULL, next_retry_at = datetime('now')
       WHERE status = 'running' AND started_at < ? AND attempts < max_attempts`
    ).run(cutoff)
    return result.changes
  }

  getJobCountByStatus(): Record<string, number> {
    const rows = getDb()
      .prepare('SELECT status, COUNT(*) as count FROM capture_jobs GROUP BY status')
      .all() as Array<{ status: string; count: number }>
    const result: Record<string, number> = {}
    for (const r of rows) result[r.status] = r.count
    return result
  }
}
