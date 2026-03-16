-- ============================================================================
-- Screenshot Capture Service (SCS) — Database Schema
-- PostgreSQL 16+
-- ============================================================================
--
-- This schema defines the tables, indexes, and constraints for the SCS
-- screenshot capture service.
--
-- Tables:
--   1. capture_jobs    — State and metadata for each capture job
--   2. screenshots     — Generated images (results of each capture)
--   3. url_allowlist   — Allowed URL patterns (SSRF prevention)
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Extensions
-- ----------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- for gen_random_uuid()


-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------

-- Capture job status
CREATE TYPE capture_status AS ENUM (
    'queued',              -- In the queue, waiting for a worker
    'running',             -- Worker executing capture
    'processing_images',   -- Capture ok, processing/optimizing images
    'succeeded',           -- Images ready and available via CDN
    'failed',              -- Failed after all retries
    'cancelled'            -- Manually cancelled
);

-- Entity type
CREATE TYPE entity_type AS ENUM (
    'template',            -- Marketplace template
    'application',         -- Customer edge application
    'deployment'           -- Specific deploy of an application
);

-- Viewport preset
CREATE TYPE viewport_type AS ENUM (
    'card',                -- 1366x768 — preview (laptop screen)
    'detail',              -- 1280x800 — detail page
    'og'                   -- 1200x630 — Open Graph / social sharing
);

-- Image format
CREATE TYPE image_format AS ENUM (
    'webp',
    'png',
    'avif'
);

-- Error code
CREATE TYPE error_code AS ENUM (
    'timeout',             -- Timeout during navigation or capture
    'dns_failure',         -- DNS resolution failure
    'connection_refused',  -- Connection refused by the server
    'blank_page',          -- Screenshot detected as blank screen
    'ssl_error',           -- SSL certificate error
    'http_4xx',            -- HTTP 4xx response from the target site
    'http_5xx',            -- HTTP 5xx response from the target site
    'browser_crash',       -- Browser crashed during capture
    'blocked_by_firewall', -- Blocked by the target site's firewall/WAF
    'url_not_allowed',     -- URL outside the allowlist
    'internal_error'       -- Internal service error
);

-- Queue priority
CREATE TYPE queue_priority AS ENUM (
    'high',
    'low'
);


-- ----------------------------------------------------------------------------
-- Table: capture_jobs
-- Stores the state and metadata for each capture job.
-- ----------------------------------------------------------------------------

CREATE TABLE capture_jobs (
    -- Identification
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Capture data
    url             TEXT NOT NULL,                    -- Target URL (must be HTTPS + allowlist)
    entity_type     entity_type NOT NULL,             -- Entity type
    entity_id       VARCHAR(255) NOT NULL,            -- Entity ID in the source system

    -- Job state
    status          capture_status NOT NULL DEFAULT 'queued',
    priority        SMALLINT NOT NULL DEFAULT 5       -- 1 (highest) to 10 (lowest)
        CHECK (priority BETWEEN 1 AND 10),

    -- Retry control
    attempts        SMALLINT NOT NULL DEFAULT 0       -- Attempts made
        CHECK (attempts >= 0),
    max_attempts    SMALLINT NOT NULL DEFAULT 3       -- Maximum attempts
        CHECK (max_attempts >= 1 AND max_attempts <= 10),

    -- Settings
    options         JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Example options:
    -- {
    --   "viewports": ["card", "detail"],
    --   "wait_strategy": "networkidle",
    --   "wait_selector": "#app",
    --   "wait_timeout_ms": 15000,
    --   "delay_after_load_ms": 2000
    -- }

    -- Callback
    callback_url    TEXT,                             -- URL for POST after capture (optional)

    -- Batch (bulk)
    batch_id        UUID,                             -- Batch ID if bulk request

    -- Error
    error_message   TEXT,                             -- Descriptive error message
    error_code_val  error_code,                       -- Classified error code

    -- Worker
    worker_id       VARCHAR(100),                     -- Identifier of the worker that processed the job

    -- Timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,                      -- When the worker started
    completed_at    TIMESTAMPTZ,                      -- When it finished (success or failure)
    next_retry_at   TIMESTAMPTZ                       -- Next scheduled retry
);

-- Comments
COMMENT ON TABLE capture_jobs IS 'Screenshot capture jobs. Each job represents a request to capture a URL.';
COMMENT ON COLUMN capture_jobs.url IS 'Target URL for capture. Must be HTTPS and match a pattern in the url_allowlist.';
COMMENT ON COLUMN capture_jobs.options IS 'Capture settings in JSONB: viewports, wait_strategy, wait_selector, timeouts.';
COMMENT ON COLUMN capture_jobs.priority IS 'Queue priority: 1 = highest, 10 = lowest. Default: 5.';
COMMENT ON COLUMN capture_jobs.batch_id IS 'Batch identifier when the job was created via POST /captures/bulk.';
COMMENT ON COLUMN capture_jobs.error_code_val IS 'Classified error code for grouping and metrics.';
COMMENT ON COLUMN capture_jobs.next_retry_at IS 'Timestamp for the next retry. NULL if no retry is scheduled.';


-- ========================
-- Indexes: capture_jobs
-- ========================

-- Efficient lookup of the next job in the queue (worker polling)
-- Filters only queued jobs, ordered by priority and creation time
CREATE INDEX idx_jobs_queue_poll
    ON capture_jobs (priority ASC, created_at ASC)
    WHERE status = 'queued';

-- Lookup by entity (deduplication, history queries)
CREATE INDEX idx_jobs_entity
    ON capture_jobs (entity_type, entity_id);

-- Lookup by batch
CREATE INDEX idx_jobs_batch
    ON capture_jobs (batch_id)
    WHERE batch_id IS NOT NULL;

-- Pending retry jobs
CREATE INDEX idx_jobs_retry
    ON capture_jobs (next_retry_at ASC)
    WHERE status = 'queued' AND attempts > 0;

-- Stale job detection (jobs running too long = worker crashed)
CREATE INDEX idx_jobs_stale
    ON capture_jobs (started_at)
    WHERE status = 'running';

-- Deduplication: fast lookup of active jobs for the same entity
CREATE INDEX idx_jobs_active_entity
    ON capture_jobs (entity_type, entity_id)
    WHERE status IN ('queued', 'running');


-- ----------------------------------------------------------------------------
-- Table: screenshots
-- Stores the results (generated images) of each capture.
-- A capture can generate multiple screenshots (one per viewport/format).
-- ----------------------------------------------------------------------------

CREATE TABLE screenshots (
    -- Identification
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Job reference
    job_id          UUID NOT NULL REFERENCES capture_jobs(id) ON DELETE CASCADE,

    -- Entity (denormalized for fast queries without JOIN)
    entity_type     entity_type NOT NULL,
    entity_id       VARCHAR(255) NOT NULL,

    -- Image details
    viewport        viewport_type NOT NULL,           -- card, detail, og
    width           INT NOT NULL                      -- Width in pixels
        CHECK (width > 0 AND width <= 3840),
    height          INT NOT NULL                      -- Height in pixels
        CHECK (height > 0 AND height <= 2160),
    format          image_format NOT NULL,            -- webp, png, avif

    -- Storage
    storage_key     TEXT NOT NULL,                    -- Key in Edge Storage
    -- Example: screenshots/template/sol-12345/card-400x300-v1710583212.webp
    cdn_url         TEXT NOT NULL,                    -- Public URL via CDN
    -- Example: https://screenshots.example.com/template/sol-12345/card-400x300-v1710583212.webp
    file_size_bytes INT                               -- File size
        CHECK (file_size_bytes IS NULL OR file_size_bytes > 0),

    -- Versioning
    is_latest       BOOLEAN NOT NULL DEFAULT TRUE,    -- Only the most recent = true

    -- Timestamp
    captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Comments
COMMENT ON TABLE screenshots IS 'Generated screenshot images. Each job can generate multiple screenshots (viewports x formats).';
COMMENT ON COLUMN screenshots.entity_type IS 'Denormalized from capture_jobs to allow queries without JOIN.';
COMMENT ON COLUMN screenshots.is_latest IS 'TRUE for the most recent screenshot of each entity+viewport+format. Only one per combination.';
COMMENT ON COLUMN screenshots.storage_key IS 'Full file key in SCS Edge Storage.';
COMMENT ON COLUMN screenshots.cdn_url IS 'Public URL served via SCS CDN. Immutable cache (new capture = new key).';


-- ========================
-- Indexes: screenshots
-- ========================

-- Main query: find the most recent screenshots for an entity
-- Used by GET /v1/entities/:type/:id/screenshots
CREATE INDEX idx_screenshots_entity_latest
    ON screenshots (entity_type, entity_id)
    WHERE is_latest = TRUE;

-- Constraint: only 1 "latest" screenshot per entity+viewport+format combination
-- Ensures data integrity when updating is_latest
CREATE UNIQUE INDEX idx_screenshots_unique_latest
    ON screenshots (entity_type, entity_id, viewport, format)
    WHERE is_latest = TRUE;

-- Garbage collection: find old screenshots for cleanup
CREATE INDEX idx_screenshots_gc
    ON screenshots (captured_at)
    WHERE is_latest = FALSE;

-- Lookup by job (to list results of a specific job)
CREATE INDEX idx_screenshots_job
    ON screenshots (job_id);


-- ----------------------------------------------------------------------------
-- Table: url_allowlist
-- Allowed URL patterns for capture (SSRF prevention).
-- Only URLs that match an active pattern are accepted.
-- ----------------------------------------------------------------------------

CREATE TABLE url_allowlist (
    id          SERIAL PRIMARY KEY,
    pattern     TEXT NOT NULL,                        -- Regex pattern (e.g.: ^[\w-]+\.example\.app$)
    description TEXT,                                 -- Pattern description
    active      BOOLEAN NOT NULL DEFAULT TRUE,        -- Whether the pattern is active
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Comments
COMMENT ON TABLE url_allowlist IS 'Allowed URL patterns for capture. SSRF prevention.';
COMMENT ON COLUMN url_allowlist.pattern IS 'Regular expression to validate the URL hostname. E.g.: ^[\\w-]+\\.example\\.app$';

-- Index for looking up active patterns
CREATE INDEX idx_allowlist_active
    ON url_allowlist (active)
    WHERE active = TRUE;


-- ----------------------------------------------------------------------------
-- Initial data: url_allowlist
-- Default patterns for the SCS environment
-- ----------------------------------------------------------------------------

INSERT INTO url_allowlist (pattern, description) VALUES
    ('^[\w-]+\.example\.app$', 'SCS edge applications (*.example.app)'),
    ('^[\w-]+\.exampleedge\.net$', 'SCS edge network (*.exampleedge.net)'),
    ('^[\w-]+\.exampleedge\.com$', 'SCS edge network (*.exampleedge.com)');


-- ============================================================================
-- Functions
-- ============================================================================

-- Function: Update is_latest when inserting a new screenshot
-- Marks the previous one as is_latest=false before inserting the new one
CREATE OR REPLACE FUNCTION update_latest_screenshot()
RETURNS TRIGGER AS $$
BEGIN
    -- If the new screenshot is marked as latest, unmark the previous ones
    IF NEW.is_latest = TRUE THEN
        UPDATE screenshots
        SET is_latest = FALSE
        WHERE entity_type = NEW.entity_type
          AND entity_id = NEW.entity_id
          AND viewport = NEW.viewport
          AND format = NEW.format
          AND is_latest = TRUE
          AND id != NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_latest_screenshot
    AFTER INSERT ON screenshots
    FOR EACH ROW
    EXECUTE FUNCTION update_latest_screenshot();

COMMENT ON FUNCTION update_latest_screenshot IS 'Ensures that only 1 screenshot is marked as is_latest for each entity+viewport+format combination.';


-- Function: Update updated_at in url_allowlist
CREATE OR REPLACE FUNCTION update_allowlist_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_allowlist_timestamp
    BEFORE UPDATE ON url_allowlist
    FOR EACH ROW
    EXECUTE FUNCTION update_allowlist_timestamp();


-- ============================================================================
-- Operations notes
-- ============================================================================
--
-- GARBAGE COLLECTION (run daily):
--   1. Find old screenshots:
--      SELECT storage_key FROM screenshots
--      WHERE is_latest = FALSE AND captured_at < NOW() - INTERVAL '7 days';
--
--   2. Delete files from Edge Storage (via API)
--
--   3. Remove records from the database:
--      DELETE FROM screenshots
--      WHERE is_latest = FALSE AND captured_at < NOW() - INTERVAL '7 days';
--
-- STALE JOB RECOVERY (run every 5 minutes):
--   UPDATE capture_jobs
--   SET status = 'queued',
--       attempts = attempts + 1,
--       next_retry_at = NOW() + INTERVAL '10 seconds',
--       worker_id = NULL,
--       started_at = NULL
--   WHERE status = 'running'
--     AND started_at < NOW() - INTERVAL '5 minutes'
--     AND attempts < max_attempts;
--
-- DEAD LETTER (jobs that have permanently failed):
--   SELECT * FROM capture_jobs
--   WHERE status = 'failed'
--   ORDER BY completed_at DESC;
--
-- ============================================================================
