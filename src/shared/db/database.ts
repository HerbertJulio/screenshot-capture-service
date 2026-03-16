import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { getConfig } from '../config.js'
import type {
  CaptureJob,
  CaptureOptions,
  EntityType,
  ErrorCode,
  JobStatus,
  ScreenshotRecord,
  ViewportName,
  ImageFormat,
} from '../types/job.types.js'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.')
  return db
}

export function initDatabase(): void {
  const config = getConfig()
  db = new Database(config.DB_PATH, { fileMustExist: false })

  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('cache_size = -64000')   // 64MB cache
  db.pragma('temp_store = MEMORY')   // temp tables in memory
  db.pragma('mmap_size = 268435456') // 256MB memory-mapped I/O

  db.exec(`
    CREATE TABLE IF NOT EXISTS capture_jobs (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('template','application','deployment')),
      entity_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','processing_images','succeeded','failed','cancelled')),
      priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      options TEXT NOT NULL DEFAULT '{}',
      callback_url TEXT,
      batch_id TEXT,
      error_message TEXT,
      error_code TEXT,
      worker_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      next_retry_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_queue ON capture_jobs(priority, created_at) WHERE status = 'queued';
    CREATE INDEX IF NOT EXISTS idx_jobs_entity ON capture_jobs(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_active ON capture_jobs(entity_type, entity_id) WHERE status IN ('queued', 'running');
    CREATE INDEX IF NOT EXISTS idx_jobs_stale ON capture_jobs(started_at) WHERE status = 'running';

    CREATE TABLE IF NOT EXISTS screenshots (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES capture_jobs(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      viewport TEXT NOT NULL CHECK (viewport IN ('card','detail')),
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      format TEXT NOT NULL CHECK (format IN ('webp','png')),
      storage_key TEXT NOT NULL,
      cdn_url TEXT NOT NULL,
      file_size_bytes INTEGER,
      is_latest INTEGER NOT NULL DEFAULT 1,
      captured_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ss_entity ON screenshots(entity_type, entity_id) WHERE is_latest = 1;
    CREATE INDEX IF NOT EXISTS idx_ss_job ON screenshots(job_id);
  `)
}

// -- Prepared statements (lazy) --

const stmtCache = new Map<string, Database.Statement>()

function stmt(key: string, sql: string): Database.Statement {
  let s = stmtCache.get(key)
  if (!s) {
    s = getDb().prepare(sql)
    stmtCache.set(key, s)
  }
  return s
}

// -- Jobs --

export function createJob(params: {
  url: string
  entityType: EntityType
  entityId: string
  options: CaptureOptions
  callbackUrl?: string
  batchId?: string
  priority?: number
}): CaptureJob {
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
  return getJobById(id)!
}

export function findActiveJob(entityType: EntityType, entityId: string): CaptureJob | null {
  const row = stmt(
    'findActive',
    `SELECT * FROM capture_jobs WHERE entity_type = ? AND entity_id = ? AND status IN ('queued','running') LIMIT 1`
  ).get(entityType, entityId) as RawJob | undefined
  return row ? mapJob(row) : null
}

export function getJobById(id: string): CaptureJob | null {
  const row = stmt('getJob', 'SELECT * FROM capture_jobs WHERE id = ?').get(id) as RawJob | undefined
  return row ? mapJob(row) : null
}

export function claimNextJob(workerId: string): CaptureJob | null {
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

export function updateJobStatus(
  id: string,
  status: JobStatus,
  extra?: { errorCode?: ErrorCode; errorMessage?: string; nextRetryAt?: string }
): void {
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

export function recoverStaleJobs(timeoutMinutes: number = 5): number {
  const cutoff = new Date(Date.now() - timeoutMinutes * 60_000).toISOString()
  const result = stmt(
    'recoverStale',
    `UPDATE capture_jobs
     SET status = 'queued', worker_id = NULL, started_at = NULL, next_retry_at = datetime('now')
     WHERE status = 'running' AND started_at < ? AND attempts < max_attempts`
  ).run(cutoff)
  return result.changes
}

export function getJobCountByStatus(): Record<string, number> {
  const rows = getDb()
    .prepare('SELECT status, COUNT(*) as count FROM capture_jobs GROUP BY status')
    .all() as Array<{ status: string; count: number }>
  const result: Record<string, number> = {}
  for (const r of rows) result[r.status] = r.count
  return result
}

// -- Screenshots --

export function insertScreenshot(params: {
  jobId: string
  entityType: EntityType
  entityId: string
  viewport: ViewportName
  width: number
  height: number
  format: ImageFormat
  storageKey: string
  cdnUrl: string
  fileSizeBytes: number
}): ScreenshotRecord {
  const id = randomUUID()

  getDb().transaction(() => {
    stmt(
      'unsetLatest',
      `UPDATE screenshots SET is_latest = 0
       WHERE entity_type = ? AND entity_id = ? AND viewport = ? AND format = ? AND is_latest = 1`
    ).run(params.entityType, params.entityId, params.viewport, params.format)

    stmt(
      'insertSS',
      `INSERT INTO screenshots (id, job_id, entity_type, entity_id, viewport, width, height, format, storage_key, cdn_url, file_size_bytes, is_latest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(
      id,
      params.jobId,
      params.entityType,
      params.entityId,
      params.viewport,
      params.width,
      params.height,
      params.format,
      params.storageKey,
      params.cdnUrl,
      params.fileSizeBytes
    )
  })()

  return getScreenshotById(id)!
}

function getScreenshotById(id: string): ScreenshotRecord | null {
  const row = stmt('getSS', 'SELECT * FROM screenshots WHERE id = ?').get(id) as RawScreenshot | undefined
  return row ? mapScreenshot(row) : null
}

export function getLatestScreenshots(entityType: EntityType, entityId: string): ScreenshotRecord[] {
  const rows = stmt(
    'getLatest',
    `SELECT * FROM screenshots WHERE entity_type = ? AND entity_id = ? AND is_latest = 1 ORDER BY viewport`
  ).all(entityType, entityId) as RawScreenshot[]
  return rows.map(mapScreenshot)
}

export function getScreenshotsByJobId(jobId: string): ScreenshotRecord[] {
  const rows = stmt('getByJob', 'SELECT * FROM screenshots WHERE job_id = ?').all(jobId) as RawScreenshot[]
  return rows.map(mapScreenshot)
}

export function deleteScreenshotsByEntity(entityType: EntityType, entityId: string): number {
  const result = stmt(
    'deleteSS',
    'DELETE FROM screenshots WHERE entity_type = ? AND entity_id = ?'
  ).run(entityType, entityId)
  return result.changes
}

// -- Row mapping --

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

interface RawScreenshot {
  id: string
  job_id: string
  entity_type: string
  entity_id: string
  viewport: string
  width: number
  height: number
  format: string
  storage_key: string
  cdn_url: string
  file_size_bytes: number | null
  is_latest: number
  captured_at: string
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

function mapScreenshot(row: RawScreenshot): ScreenshotRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    entityType: row.entity_type as EntityType,
    entityId: row.entity_id,
    viewport: row.viewport as ViewportName,
    width: row.width,
    height: row.height,
    format: row.format as ImageFormat,
    storageKey: row.storage_key,
    cdnUrl: row.cdn_url,
    fileSizeBytes: row.file_size_bytes,
    isLatest: row.is_latest === 1,
    capturedAt: row.captured_at,
  }
}
