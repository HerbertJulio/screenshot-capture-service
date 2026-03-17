import Database from 'better-sqlite3'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.')
  return db
}

export function initDatabase(dbPath: string): Database.Database {
  db = new Database(dbPath, { fileMustExist: false })

  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('cache_size = -64000')
  db.pragma('temp_store = MEMORY')
  db.pragma('mmap_size = 268435456')

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

  return db
}

// -- Prepared Statement Cache --

const stmtCache = new Map<string, Database.Statement>()

export function stmt(key: string, sql: string): Database.Statement {
  let s = stmtCache.get(key)
  if (!s) {
    s = getDb().prepare(sql)
    stmtCache.set(key, s)
  }
  return s
}
