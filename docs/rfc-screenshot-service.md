# RFC: Screenshot Capture Service (SCS)

| Field | Value |
|-------|-------|
| **Status** | Draft |
| **Author** | SCS Engineering |
| **Date** | 2026-03-16 |
| **Type** | Design Doc |
| **Area** | Platform Services |

---

## Table of Contents

- [1. Context and Problem](#1-context-and-problem)
- [2. What is a Headless Browser](#2-what-is-a-headless-browser)
- [3. Proposal — MVP (Simple Solution)](#3-proposal--mvp-simple-solution)
- [4. Proposal — Full Solution](#4-proposal--full-solution)
- [5. API Contract](#5-api-contract)
- [6. Data Model](#6-data-model)
- [7. Processing Pipeline](#7-processing-pipeline)
- [8. Storage and CDN](#8-storage-and-cdn)
- [9. Security](#9-security)
- [10. Scaling and Resource Management](#10-scaling-and-resource-management)
- [11. Observability](#11-observability)
- [12. Retry and Failure Handling](#12-retry-and-failure-handling)
- [13. Recommended Stack](#13-recommended-stack)
- [14. Project Structure](#14-project-structure)
- [15. Integration (Consumption Pattern)](#15-integration-consumption-pattern)
- [16. Alternatives Considered](#16-alternatives-considered)
- [17. Phased Rollout](#17-phased-rollout)
- [18. Risks and Mitigations](#18-risks-and-mitigations)
- [19. Open Decisions](#19-open-decisions)

---

## 1. Context and Problem

### Problem

SCS offers a template catalog (Marketplace) whose demos are published at edge URLs (e.g., `*.example.app`). Currently, the only visual representation of a template is the **vendor icon** (40x40px) — there is no real preview of what the template produces. The Integrations team must upload preview images manually, which:

- Does not scale with catalog growth
- Becomes outdated when the template is republished
- Depends on recurring manual effort

### Opportunity

Beyond templates, the same problem applies to **customer application deploys** (import from GitHub, edge applications). Having automatic previews improves the dashboard experience and aligns SCS with what Vercel and Netlify already offer.

### Benchmarks

| Platform | What they do |
|----------|-------------|
| **Vercel** | Displays screenshots of the latest production deployment on the dashboard to give a "quick glimpse" of projects |
| **Netlify** | Uses a headless browser after each deploy to generate site thumbnails on the dashboard |

### Objective

Create a **standalone SCS service** that:
1. Receives a URL and automatically generates a preview image via headless browser
2. Stores the image in Edge Storage and serves it via CDN
3. Supports multiple entity types (template, application, deployment)
4. Regenerates screenshots automatically when the entity is updated
5. Is reusable for any SCS product that needs URL previews

---

## 2. What is a Headless Browser

A **headless browser** is a web browser (such as Chrome/Chromium) that runs **without a graphical interface** — that is, without opening a visible window. It executes everything a normal browser does (renders HTML, CSS, executes JavaScript, loads images, makes network requests), but in "invisible" mode on the server.

### Why is it necessary for screenshots?

Modern sites (SPAs like React, Vue, Angular) render content via JavaScript — a simple HTTP GET of the HTML is not enough. The headless browser:

1. Executes the page's JavaScript in full
2. Waits for the DOM to be ready (including lazy loading, API calls)
3. Renders the visual layout (CSS, images, fonts)
4. "Takes a photo" of the rendered page

### Available tools

| Tool | Description | Pros | Cons |
|------|-------------|------|------|
| **Playwright** | Microsoft's framework for browser automation | Native waits, multi-browser, modern API, more stable | Slightly heavier |
| **Puppeteer** | Google's framework for Chrome automation | Lighter, large community | Chrome only, manual waits |

### Simplified example (Playwright)

```typescript
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage()

// Set the "screen" size
await page.setViewportSize({ width: 1280, height: 800 })

// Navigate and wait for full load
await page.goto('https://template.example.app', { waitUntil: 'networkidle' })

// Capture the screenshot
const screenshot = await page.screenshot({ type: 'png' })
// screenshot is a Buffer containing the rendered page image

await browser.close()
```

### Resource trade-off

Headless browsers consume significant resources:
- **Memory:** ~200-400MB per browser instance
- **CPU:** spikes during rendering of complex pages
- **Time:** 5-15 seconds per capture (navigation + rendering + screenshot)

Therefore, the service needs careful management of the browser pool and dedicated containers with sufficient resources.

---

## 3. Proposal — MVP (Simple Solution)

The MVP focuses on **solving the immediate problem**: generating template previews automatically, with minimal infrastructure.

### MVP Scope

- **1 entity type:** template only
- **1 viewport:** card (400 x 300 px)
- **1 output format:** WebP
- **Trigger:** Manual API call or via template publish CI/CD
- **No message queue** — inline processing with a simple job runner
- **No webhook/callback** — clients poll for status

### MVP Architecture

```
Clients / CI Pipeline
        |
   POST /v1/captures
        |
  +-----v-----------+
  | API (Fastify)    |
  | + Inline worker  |  <- same process, no separate queue
  +-----+------------+
        |
  Playwright capture
        |
  Sharp resize/webp
        |
  +-----v-----------+     +------------------+
  | Edge Storage     |---->| SCS CDN        |
  +------------------+     +------------------+
        |
  SQLite (job state)
```

### MVP Simplification Decisions

| Area | MVP Decision | Justification |
|------|-------------|---------------|
| Process | API and worker in the same container | Avoids infrastructure complexity; 1 container to deploy and operate |
| Database | SQLite (better-sqlite3) | Zero configuration, embedded, sufficient for hundreds of records |
| Queue | No queue — `setImmediate` + polling | Low volume (< 50 captures/day); a queue is over-engineering at this stage |
| Browser | 1 browser at a time (serial) | No concurrency; simplifies memory management |
| Retry | 1 retry with fixed delay (5s) | Sufficient for transient failures; persistent errors go to `failed` |
| Viewports | Card only (400x300) | Covers the main use case (template catalog) |

### MVP API

```
POST /v1/captures
  body: { url, entity_type: "template", entity_id }
  -> 202 { job_id, status: "queued" }

GET /v1/captures/:job_id
  -> { job_id, status, image_url?, error? }

GET /v1/screenshots/:entity_type/:entity_id
  -> { image_url, captured_at }
```

### MVP Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 + TypeScript |
| API | Fastify |
| Browser | Playwright (Chromium) |
| Image processing | Sharp |
| Storage | SCS Edge Storage (S3-compatible) |
| CDN | SCS CDN |
| State | SQLite (better-sqlite3) |
| Deploy | 1 Docker container (ECS or EC2) |

### MVP Security

- URL validation: HTTPS only + domain allowlist (`*.example.app`)
- Basic rate limit: 10 req/min global
- Default Playwright browser sandbox (enabled by default)

### MVP Blank Page Detection

- Wait `networkidle` + 2s delay after load
- 1 retry with 5s delay if pixel variance < threshold (>95% pixels of the same color = blank)
- If it fails after retry: mark as `failed`, no image generated

### MVP Flow (step by step)

```
1. CI/CD publishes template -> calls POST /v1/captures
2. API validates URL (HTTPS + allowlist), creates job in SQLite, starts capture via setImmediate
3. Playwright opens URL, waits for networkidle + 2s, screenshot
4. Sharp converts to WebP 400x300 (quality 80)
5. Upload to Edge Storage: screenshots/template/{entity_id}/card-400x300-v{timestamp}.webp
6. Updates job in SQLite with image_url and status=succeeded
7. Client calls GET /v1/screenshots/template/{id} -> receives image_url to use as <img src>
```

### What the MVP Does NOT Have

| Feature | Status | When it comes |
|---------|--------|--------------|
| Message queue (SQS/BullMQ) | -- | v1.0 |
| PostgreSQL | -- | v1.0 |
| Multiple viewports (detail, og) | -- | v1.1 |
| Webhook/callback notifications | -- | v1.1 |
| Browser pool | -- | v1.0 |
| Bulk endpoint | -- | v1.0 |
| Entity types application/deployment | -- | v1.1 |
| Prometheus metrics/alerts | -- | v2.0 |
| Stale job sweeper | -- | v1.0 |
| Dead letter queue | -- | v2.0 |
| Autoscaling | -- | v2.0 |

---

## 4. Proposal — Full Solution

### Architecture

```
Clients (internal APIs, CI/CD, dashboards)
        |
   REST API (HTTPS)
        |
  +-----v------+
  | API Gateway | (rate limit, auth, routing)
  +-----+------+
        |
  +-----v-----------+     +------------------+
  | Capture API      |     | Status/Query API |
  | (submit jobs)    |     | (read results)   |
  +-----+------------+     +--------+---------+
        |                           |
  +-----v------+           +--------v---------+
  | Message     |           | PostgreSQL       |
  | Queue (SQS) |           | (job state)      |
  +-----+------+           +------------------+
        |
  +-----v-----------+
  | Worker Pool      |
  | (Playwright)     |
  +-----+------------+
        |
  +-----v-----------+
  | Image Processor  |
  | (Sharp/libvips)  |
  +-----+------------+
        |
  +-----v-----------+     +------------------+
  | Edge Storage     |---->| SCS CDN        |
  | (object storage) |     | (image serving)  |
  +------------------+     +------------------+
```

### Components

| Component | Responsibility | Technology |
|-----------|---------------|-----------|
| **API Gateway** | Auth, rate limiting, routing | SCS Edge Firewall + Edge Functions |
| **Capture API** | Job submission, validation, deduplication | Node.js (Fastify) |
| **Status/Query API** | Status queries and screenshots by entity | Node.js (Fastify) |
| **Message Queue** | Decouple submission from execution, back-pressure | AWS SQS (2 queues: high + low priority) |
| **Worker Pool** | Headless browser capture + retry | Node.js + Playwright |
| **Image Processor** | Resize, format conversion, optimization | Sharp (libvips) |
| **Storage** | Persistence with structured keys | SCS Edge Storage (S3-compatible) |
| **CDN** | Serve images globally with cache | SCS CDN |
| **Database** | Job state, metadata, audit trail | PostgreSQL 16 |
| **Webhook Notifier** | Post-capture notification for interested systems | Internal module in the worker |
| **Scheduler** | Stale job recovery, garbage collection | Internal cron jobs |

### Delta MVP -> Full

| Area | MVP | Full |
|------|-----|------|
| Entity types | template only | template, application, deployment |
| Viewports | card (400x300) | card (400x300), detail (1280x800), og (1200x630) |
| Output formats | WebP | WebP + PNG fallback + AVIF |
| State/Database | SQLite | PostgreSQL 16 |
| Queue | Inline (setImmediate) | SQS with 2 queues (high/low priority) |
| Workers | 1 process, serial | Pool of 2-8 containers, browser pool (3 browsers/container) |
| Retry | 1 simple retry | 3 retries with exponential backoff + strategy escalation |
| Trigger | Manual API / CI | Automatic webhooks (template.published, deployment.finished) |
| Notification | Polling only | Polling + callback_url webhook |
| Bulk | -- | POST /v1/captures/bulk (up to 100 items) |
| Observability | Basic logs (stdout) | Prometheus metrics, alerts, structured logging (OpenTelemetry) |
| Blank detection | 1 simple strategy | Multi-strategy with escalation (3 attempts) |
| DLQ | -- | Dead letter queue + inspection dashboard |
| GC | Manual | Scheduled job for old file cleanup (7 days) |
| Autoscaling | Fixed (1 container) | Queue-depth based (2-8 workers) |

---

## 5. API Contract

### 5.1. POST /v1/captures — Submit capture

**Request:**

```json
{
  "url": "https://example-template.example.app",
  "entity_type": "template",
  "entity_id": "sol-12345",
  "callback_url": "https://api.example.com/internal/webhooks/screenshot-ready",
  "options": {
    "viewports": ["card", "detail"],
    "wait_strategy": "networkidle",
    "wait_selector": "#app",
    "wait_timeout_ms": 15000,
    "delay_after_load_ms": 2000
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string (URL) | Yes | URL to capture. Must be HTTPS and on the allowlist |
| `entity_type` | enum | Yes | `template`, `application`, or `deployment` |
| `entity_id` | string | Yes | Entity ID in the source system |
| `callback_url` | string (URL) | No | URL to POST with the result after capture |
| `options.viewports` | string[] | No | Viewports to capture. Default: `["card"]` |
| `options.wait_strategy` | enum | No | `networkidle` (default), `domcontentloaded`, `load` |
| `options.wait_selector` | string | No | CSS selector to wait for before capturing |
| `options.wait_timeout_ms` | number | No | Timeout for wait strategy. Default: 15000 |
| `options.delay_after_load_ms` | number | No | Additional delay after load. Default: 2000 |

**Response (202 Accepted):**

```json
{
  "job_id": "job_abc123",
  "status": "queued",
  "created_at": "2026-03-16T10:00:00Z",
  "estimated_completion_seconds": 30
}
```

**Deduplication:** If a `queued` or `running` job already exists for the same `entity_type + entity_id`, the existing `job_id` is returned instead of creating a new one.

### 5.2. GET /v1/captures/:job_id — Job status

**Response:**

```json
{
  "job_id": "job_abc123",
  "status": "succeeded",
  "url": "https://example-template.example.app",
  "entity_type": "template",
  "entity_id": "sol-12345",
  "attempts": 1,
  "created_at": "2026-03-16T10:00:00Z",
  "completed_at": "2026-03-16T10:00:12Z",
  "results": [
    {
      "viewport": "card",
      "width": 400,
      "height": 300,
      "format": "webp",
      "image_url": "https://screenshots.example.com/template/sol-12345/card-400x300-v1710583212.webp",
      "file_size_bytes": 24576
    },
    {
      "viewport": "detail",
      "width": 1280,
      "height": 800,
      "format": "webp",
      "image_url": "https://screenshots.example.com/template/sol-12345/detail-1280x800-v1710583212.webp",
      "file_size_bytes": 89120
    }
  ]
}
```

| Status | Description |
|--------|-------------|
| `queued` | Job is in the queue, waiting for a worker |
| `running` | Worker is executing the capture |
| `processing_images` | Capture completed, processing/optimizing images |
| `succeeded` | Images are ready and available via CDN |
| `failed` | Failed after all retries |
| `cancelled` | Job manually cancelled |

### 5.3. GET /v1/entities/:entity_type/:entity_id/screenshots — Screenshots by entity

Returns the most recent screenshots (`is_latest = true`) for an entity.

**Response:**

```json
{
  "entity_type": "template",
  "entity_id": "sol-12345",
  "latest_capture_at": "2026-03-16T10:00:12Z",
  "screenshots": [
    {
      "viewport": "card",
      "image_url": "https://screenshots.example.com/template/sol-12345/card-400x300-v1710583212.webp",
      "width": 400,
      "height": 300,
      "format": "webp"
    },
    {
      "viewport": "detail",
      "image_url": "https://screenshots.example.com/template/sol-12345/detail-1280x800-v1710583212.webp",
      "width": 1280,
      "height": 800,
      "format": "webp"
    }
  ]
}
```

### 5.4. POST /v1/captures/bulk — Batch backfill

For initial processing (backfill) of all existing templates.

**Request:**

```json
{
  "items": [
    { "url": "https://t1.example.app", "entity_type": "template", "entity_id": "sol-001" },
    { "url": "https://t2.example.app", "entity_type": "template", "entity_id": "sol-002" }
  ],
  "priority": "low"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `items` | array | List of captures (max 100 per request) |
| `priority` | enum | `high` (default) or `low` (low priority queue) |

**Response (202 Accepted):**

```json
{
  "batch_id": "batch_xyz",
  "total_jobs": 2,
  "status": "queued"
}
```

### 5.5. POST /v1/events — Webhook receiver (internal events)

Receives events from internal SCS systems to trigger captures automatically.

**Request:**

```json
{
  "event_type": "template.published",
  "entity_type": "template",
  "entity_id": "sol-12345",
  "url": "https://updated-template.example.app",
  "timestamp": "2026-03-16T10:00:00Z"
}
```

| Event Type | Action |
|-----------|--------|
| `template.published` | Capture/recapture the template preview |
| `template.updated` | Recapture the preview |
| `deployment.finished` | Capture the deploy preview (future) |
| `manual.trigger` | On-demand capture |

**Authentication:** HMAC-SHA256 in the `X-Webhook-Signature` header with a shared secret.

### 5.6. DELETE /v1/entities/:entity_type/:entity_id/screenshots — Clear screenshots

Removes all screenshots for an entity (storage + database).

**Response:** `204 No Content`

### 5.7. Health Checks

```
GET /healthz   -> 200 { "status": "ok" }
GET /readyz    -> 200 { "status": "ok", "db": "connected", "queue": "connected" }
GET /metrics   -> Prometheus text format
```

---

## 6. Data Model

### 6.1. Table: capture_jobs

Stores the state and metadata of each capture job.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | UUID PK | `gen_random_uuid()` | Unique job identifier |
| `url` | TEXT NOT NULL | — | Target URL for the capture |
| `entity_type` | VARCHAR(50) NOT NULL | — | `template`, `application`, `deployment` |
| `entity_id` | VARCHAR(255) NOT NULL | — | Entity ID in the source system |
| `status` | VARCHAR(20) NOT NULL | `'queued'` | Current job state |
| `priority` | SMALLINT NOT NULL | `5` | 1 (highest) to 10 (lowest) |
| `attempts` | SMALLINT NOT NULL | `0` | Attempts made |
| `max_attempts` | SMALLINT NOT NULL | `3` | Maximum number of attempts |
| `options` | JSONB NOT NULL | `'{}'` | Configuration (viewports, wait strategy, timeouts) |
| `callback_url` | TEXT | — | URL for post-capture notification |
| `batch_id` | UUID | — | Batch ID (if bulk request) |
| `error_message` | TEXT | — | Error message (if failed) |
| `error_code` | VARCHAR(50) | — | Error code (`timeout`, `dns_failure`, `blank_page`, etc.) |
| `worker_id` | VARCHAR(100) | — | Identifier of the worker that processed the job |
| `created_at` | TIMESTAMPTZ NOT NULL | `NOW()` | When the job was created |
| `started_at` | TIMESTAMPTZ | — | When the worker started |
| `completed_at` | TIMESTAMPTZ | — | When it finished (success or final failure) |
| `next_retry_at` | TIMESTAMPTZ | — | Next scheduled retry |

**Indexes:**
- `(status, priority, created_at) WHERE status = 'queued'` — efficient lookup for the next job
- `(entity_type, entity_id)` — lookup by entity
- `(batch_id) WHERE batch_id IS NOT NULL` — lookup by batch
- `(next_retry_at) WHERE status = 'queued' AND attempts > 0` — retry jobs

### 6.2. Table: screenshots

Stores the results (generated images) of each capture.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | UUID PK | `gen_random_uuid()` | Unique identifier |
| `job_id` | UUID FK NOT NULL | — | Reference to the capture_job |
| `entity_type` | VARCHAR(50) NOT NULL | — | Denormalized for fast queries |
| `entity_id` | VARCHAR(255) NOT NULL | — | Denormalized for fast queries |
| `viewport` | VARCHAR(20) NOT NULL | — | `card`, `detail`, `og` |
| `width` | INT NOT NULL | — | Width in pixels |
| `height` | INT NOT NULL | — | Height in pixels |
| `format` | VARCHAR(10) NOT NULL | — | `webp`, `png`, `avif` |
| `storage_key` | TEXT NOT NULL | — | Key in Edge Storage |
| `cdn_url` | TEXT NOT NULL | — | Public URL via CDN |
| `file_size_bytes` | INT | — | File size |
| `is_latest` | BOOLEAN NOT NULL | `TRUE` | Indicates whether this is the most recent version |
| `captured_at` | TIMESTAMPTZ NOT NULL | `NOW()` | Capture timestamp |

**Indexes:**
- `(entity_type, entity_id, is_latest) WHERE is_latest = TRUE` — lookup for the most recent screenshot
- `UNIQUE (entity_type, entity_id, viewport, format) WHERE is_latest = TRUE` — ensures one "latest" per combination

### 6.3. Table: url_allowlist

Security control — which domains/URL patterns are allowed.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | SERIAL PK | — | Identifier |
| `pattern` | TEXT NOT NULL | — | Regex or glob pattern (e.g., `^[\w-]+\.example\.app$`) |
| `description` | TEXT | — | Pattern description |
| `active` | BOOLEAN | `TRUE` | Whether the pattern is active |
| `created_at` | TIMESTAMPTZ | `NOW()` | When it was created |

### 6.4. Viewport Presets

| Viewport | Width | Height | Usage |
|----------|-------|--------|-------|
| `card` | 400 | 300 | Catalog cards / template list |
| `detail` | 1280 | 800 | Detail page / preview modal |
| `og` | 1200 | 630 | Open Graph / social media sharing |

---

## 7. Processing Pipeline

### 7.1. Full flow

```
1. REQUEST arrives at the API
   |
2. VALIDATE
   |-- URL against allowlist (SSRF prevention)
   |-- entity_type is a valid enum
   +-- Deduplication: if the same entity already has a queued/running job -> return existing job_id
   |
3. PERSIST job record in the database (status=queued)
   |
4. ENQUEUE message in the queue (SQS) with job_id + priority
   |
5. RESPOND 202 with job_id
   |
   --- asynchronous boundary ---
   |
6. WORKER consumes message from the queue
   |-- Updates status=running, worker_id, started_at
   |
7. CAPTURE
   |-- a. Obtains browser context from the pool (warm, not cold start)
   |-- b. Navigates to URL with timeout (30s default)
   |-- c. Applies wait strategy (networkidle + delay)
   |-- d. Checks for blank page (pixel variance analysis)
   +-- e. Captures screenshot for each configured viewport
   |
8. BLANK PAGE CHECK
   |-- If >95% of pixels are the same color -> detected as "blank"
   |-- If retries remaining: strategy escalation -> go back to step 7
   +-- If no retries left: mark as failed with error_code=blank_page
   |
9. IMAGE PROCESSING (status=processing_images)
   |-- For each captured viewport:
   |   |-- Resize to exact dimensions (Sharp)
   |   |-- Convert to WebP (quality 80) + PNG fallback
   |   +-- Strip metadata, optimization
   |
10. UPLOAD to Edge Storage
    |-- Key: screenshots/{entity_type}/{entity_id}/{viewport}-{w}x{h}-v{timestamp}.{format}
    +-- Headers: Cache-Control: public, max-age=31536000, immutable
    |
11. UPDATE database
    |-- Previous screenshots (same entity+viewport): is_latest=false
    |-- Insert new screenshots with is_latest=true
    +-- Update job: status=succeeded, completed_at
    |
12. NOTIFY
    |-- If callback_url configured: POST result
    +-- Emit internal event for other systems
    |
13. CDN serves image via Edge Storage origin
```

### 7.2. Strategies against blank screens

The biggest risk with automatic screenshots is capturing a blank screen (loading state, JS did not execute, incomplete lazy load). The service implements **progressive strategy escalation**:

| Attempt | Wait Strategy | Delay after load | Extra action |
|---------|--------------|-----------------|-------------|
| 1st | `networkidle` (no network activity for 500ms) | 2s | — |
| 2nd | `waitForSelector('body > *:not(script)')` | 3s | — |
| 3rd | `domcontentloaded` | 5s | Scroll down + scroll up (trigger lazy load) |

**Blank page detection:**

```typescript
function isBlankPage(screenshotBuffer: Buffer): boolean {
  const image = sharp(screenshotBuffer)
  const { channels } = await image.stats()

  // If the standard deviation of all channels is very low,
  // the image is essentially a solid color
  const avgStdDev = channels.reduce((sum, c) => sum + c.stdev, 0) / channels.length
  return avgStdDev < 5  // threshold: near-zero variation = blank
}
```

---

## 8. Storage and CDN

### 8.1. Key structure in Edge Storage

```
screenshots/
  template/
    sol-12345/
      card-400x300-v1710583212.webp
      card-400x300-v1710583212.png
      detail-1280x800-v1710583212.webp
      detail-1280x800-v1710583212.png
      og-1200x630-v1710583212.webp
  application/
    app-67890/
      card-400x300-v1710590000.webp
      ...
  deployment/
    deploy-11111/
      card-400x300-v1710595000.webp
      ...
```

### 8.2. Cache busting

Each capture generates a **new key** with a Unix timestamp (`v{timestamp}`). The CDN URL always points to the most recent key (queried via API). Since the key never changes after creation, the CDN can cache with `max-age=31536000, immutable` (1 year).

### 8.3. Garbage collection

A scheduled job (daily) that:
1. Finds screenshots with `is_latest = false` and `captured_at < NOW() - INTERVAL '7 days'`
2. Removes the files from Edge Storage
3. Removes the records from the database

### 8.4. Fallback via Edge Function

An Edge Function on the `screenshots.example.com` domain intercepts 404s from storage and returns a **generic SVG placeholder** with the text "Preview not available" — preventing broken images on the frontend.

### 8.5. Bucket and CDN

| Resource | Value |
|----------|-------|
| Bucket | `example-screenshots` (Edge Storage) |
| CDN domain | `screenshots.example.com` |
| Origin | Edge Storage bucket |
| Cache TTL | Immutable (1 year) — key never changes |
| Primary format | WebP (quality 80) |
| Fallback format | PNG |

---

## 9. Security

### 9.1. SSRF Prevention (Server-Side Request Forgery)

The main security risk is an attacker using the service to make the headless browser access internal infrastructure URLs.

**Measures:**

```typescript
function validateUrl(url: string): boolean {
  const parsed = new URL(url)

  // 1. Must be HTTPS
  if (parsed.protocol !== 'https:') return false

  // 2. Must match a pattern from the allowlist
  const allowedPatterns = await getActivePatterns() // from url_allowlist table
  // E.g.: /^[\w-]+\.example\.app$/, /^[\w-]+\.exampleedge\.net$/
  if (!allowedPatterns.some(p => p.test(parsed.hostname))) return false

  return true
}
```

**DNS rebinding protection:** At capture time, the worker resolves the URL's DNS and verifies that the resulting IP **is not in private ranges**:

```
Blocked: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
         127.0.0.0/8, 169.254.0.0/16, ::1, fc00::/7
```

### 9.2. Browser sandbox

- Playwright runs with sandbox **enabled** (default)
- Each capture uses an **isolated browser context** (separate cookies, storage, cache)
- Blocked access: filesystem, clipboard, geolocation, notifications, downloads
- Context discarded after each capture

### 9.3. Authentication

| Call type | Method |
|-----------|--------|
| External API (clients) | Header `X-Api-Key` validated against SCS auth service |
| Internal webhooks (events) | HMAC-SHA256 in the `X-Webhook-Signature` header with shared secret |
| Worker -> Storage | IAM credentials scoped to the `example-screenshots` bucket (write only) |

### 9.4. Rate Limiting

| Scope | Limit |
|-------|-------|
| Per API key | 60 requests/minute |
| Per entity | 1 capture every 5 minutes (deduplication) |
| Bulk endpoint | 100 items per request |
| Global (all workers) | 200 concurrent captures |

---

## 10. Scaling and Resource Management

### 10.1. Deployment: 2 container tiers

The separation into 2 tiers allows scaling API and workers independently:

```
API tier:     2-4 lightweight containers (512MB RAM, 0.5 vCPU)
              |-- Autoscale: by request count
              +-- Very lightweight (receives request, validates, enqueues)

Worker tier:  2-8 heavy containers (2GB RAM, 1 vCPU)
              |-- Autoscale: by queue depth
              +-- Heavy (browser + image processing)
```

### 10.2. Browser Pool (per worker container)

```typescript
const POOL_CONFIG = {
  minBrowsers: 1,           // minimum always active
  maxBrowsers: 3,           // maximum per container
  maxPagesPerBrowser: 10,   // recycle browser after 10 captures
  browserIdleTimeout: 60_000, // close idle browser after 60s
  pageTimeout: 30_000,      // maximum timeout per capture
}
```

- Browsers are **reused** between captures (warm pool, no cold start)
- Each capture opens a **new page** (browser context), not a new browser
- Browser is **recycled** after N pages to avoid Chromium memory leaks
- Container has a 2GB memory limit with OOM-kill protection

### 10.3. Autoscaling (Queue-Based)

| Condition | Action |
|-----------|--------|
| Queue depth > 10 for > 30s | Scale up workers |
| Queue depth = 0 for > 5 min | Scale down (minimum 2 workers) |
| CPU > 80% for > 2 min | Scale up workers |

### 10.4. Estimated throughput

| Metric | Value |
|--------|-------|
| Average capture time (load + screenshot) | 8-12 seconds |
| Image processing time | 1-2 seconds |
| Throughput per worker (pool of 3 browsers) | ~5 captures/min |
| 4 workers | ~20 captures/min |
| 8 workers (peak) | ~40 captures/min |
| Backfill of 500 templates (4 workers) | ~25 minutes |

---

## 11. Observability

### 11.1. Metrics (Prometheus)

| Metric | Type | Labels |
|--------|------|--------|
| `scs_captures_total` | Counter | `status`, `entity_type`, `viewport` |
| `scs_capture_duration_seconds` | Histogram | `entity_type`, `viewport` |
| `scs_queue_depth` | Gauge | `priority` |
| `scs_queue_wait_seconds` | Histogram | `priority` |
| `scs_browser_pool_size` | Gauge | `worker_id` |
| `scs_blank_page_detections_total` | Counter | `entity_type` |
| `scs_image_processing_seconds` | Histogram | `format`, `viewport` |
| `scs_storage_upload_seconds` | Histogram | — |
| `scs_active_workers` | Gauge | — |
| `scs_retry_total` | Counter | `error_code` |

### 11.2. Alerts

| Condition | Severity | Action |
|-----------|----------|--------|
| Success rate < 90% (15 min window) | Warning | Investigate error_code distribution |
| Success rate < 70% (5 min window) | Critical | Page on-call |
| Queue depth > 100 for > 5 min | Warning | Scale up workers |
| P95 capture time > 30s | Warning | Check target sites |
| Blank page rate > 20% | Warning | Review wait strategies |
| Worker OOM kills > 0 | Critical | Increase memory or reduce pool |

### 11.3. Structured logs

All logs in JSON format with standard fields:

```json
{
  "level": "info",
  "msg": "capture_completed",
  "job_id": "job_abc123",
  "entity_type": "template",
  "entity_id": "sol-12345",
  "url": "https://example.example.app",
  "worker_id": "worker-2",
  "duration_ms": 8450,
  "attempts": 1,
  "viewport": "card",
  "file_size_bytes": 24576,
  "blank_detected": false,
  "timestamp": "2026-03-16T10:00:12Z"
}
```

### 11.4. Health checks

```
GET /healthz   -> 200 (API is up)
GET /readyz    -> 200 (API + DB + queue are connected)
GET /metrics   -> Metrics in Prometheus format
```

---

## 12. Retry and Failure Handling

### 12.1. Error classification

| Error Code | Retryable | Max Retries | Backoff |
|-----------|-----------|-------------|---------|
| `timeout` | Yes | 3 | 10s -> 30s -> 60s |
| `dns_failure` | Yes | 2 | 30s -> 120s |
| `connection_refused` | Yes | 2 | 60s -> 300s |
| `blank_page` | Yes | 3 | 5s -> 10s -> 15s (with strategy escalation) |
| `http_5xx` | Yes | 2 | 30s -> 120s |
| `browser_crash` | Yes | 2 | 5s -> 10s |
| `ssl_error` | No | 0 | — |
| `http_4xx` | No | 0 | — |
| `blocked_by_firewall` | No | 0 | — |
| `url_not_allowed` | No | 0 | — |
| `internal_error` | Yes | 1 | 10s |

### 12.2. Retry flow

```
1. Capture fails
2. Classify error -> retryable?
   |-- No: status=failed, store error_code/message, notify callback
   +-- Yes: attempts < max_attempts?
       |-- No: status=failed, store error, notify callback
       +-- Yes: Calculate next_retry_at (exponential backoff)
               For blank_page: escalate wait strategy
               Re-enqueue with delay
```

### 12.3. Dead Letter Queue (DLQ)

Jobs that fail after all retries are moved to a DLQ for manual inspection. A dashboard allows:
- Viewing jobs in the DLQ grouped by `error_code`
- Manual retry of specific jobs
- Dismissal of non-recoverable jobs

### 12.4. Stale Job Recovery

A sweeper runs every 5 minutes and looks for jobs with:
- `status = 'running'` for more than 5 minutes (worker likely crashed)
- Re-enqueues these jobs with `attempts + 1`

---

## 13. Recommended Stack

### 13.1. Technologies and justifications

| Layer | Technology | Justification |
|-------|-----------|---------------|
| **Language** | TypeScript (Node.js 20+) | Same language as Playwright; excellent for async I/O; type safety |
| **API Framework** | Fastify | Fastest Node.js framework; native schema validation; plugin ecosystem |
| **Headless Browser** | Playwright (Chromium) | More reliable than Puppeteer; native waits (networkidle, selector); modern API; maintained by Microsoft |
| **Image Processing** | Sharp (libvips) | Fastest image processing library in Node.js; native support for WebP, AVIF, PNG |
| **Message Queue** | AWS SQS | Managed, serverless, zero maintenance; native support for delay/visibility timeout; 2 queues (high/low priority) |
| **Database** | PostgreSQL 16 | JSONB for flexible fields (options); partial indexes; reliable and mature |
| **ORM** | Drizzle ORM | Type-safe queries; lightweight (no runtime overhead); native migrations |
| **Object Storage** | SCS Edge Storage | Native to the SCS platform; S3-compatible API; edge distribution |
| **CDN** | SCS CDN | Native; Edge Functions for fallback (placeholder SVG); fast invalidation |
| **Container Runtime** | Docker | Required for Playwright (needs Chromium + system dependencies) |
| **Orchestration** | ECS or Kubernetes | Autoscaling, health checks, resource limits |
| **Observability** | OpenTelemetry + Datadog/Grafana | Standard observability stack; automatic instrumentation for Node.js |
| **Validation** | Zod | Type-safe; declarative; excellent for validating API inputs |
| **Config** | dotenv + Zod | Environment variables validated with a typed schema |

### 13.2. Alternative: Puppeteer vs Playwright

We chose **Playwright** because:
- `waitUntil: 'networkidle'` is built-in and more reliable
- Auto-wait for selectors (no explicit `waitForSelector` needed in most cases)
- Browser contexts are lighter than separate Puppeteer instances
- Supports multiple browsers (Chromium, Firefox, WebKit) if we need them in the future
- Actively maintained by Microsoft with regular releases

---

## 14. Project Structure

```
screenshot-capture-service/
|
+-- src/
|   +-- api/
|   |   +-- routes/
|   |   |   +-- captures.ts           # POST /captures, GET /captures/:id
|   |   |   +-- entities.ts           # GET /entities/:type/:id/screenshots
|   |   |   +-- events.ts             # POST /events (webhook receiver)
|   |   |   +-- health.ts             # /healthz, /readyz, /metrics
|   |   +-- middleware/
|   |   |   +-- auth.ts               # API key + webhook signature validation
|   |   |   +-- rate-limit.ts         # Rate limiting per key and global
|   |   |   +-- error-handler.ts      # Error response formatting
|   |   +-- server.ts                 # Fastify app setup
|   |
|   +-- worker/
|   |   +-- consumer.ts               # Queue consumer (SQS polling)
|   |   +-- capture-engine.ts         # Playwright orchestration
|   |   +-- browser-pool.ts           # Browser instance pool management
|   |   +-- blank-detector.ts         # Pixel variance analysis
|   |   +-- wait-strategies.ts        # networkidle, selector, delay strategies
|   |
|   +-- processing/
|   |   +-- image-processor.ts        # Sharp resize/convert/optimize
|   |   +-- storage-uploader.ts       # Edge Storage upload
|   |
|   +-- shared/
|   |   +-- db/
|   |   |   +-- schema.ts             # Drizzle ORM schema
|   |   |   +-- client.ts             # Database connection
|   |   |   +-- migrations/           # SQL migrations
|   |   +-- queue/
|   |   |   +-- producer.ts           # Enqueue jobs
|   |   |   +-- consumer.ts           # Dequeue jobs
|   |   +-- security/
|   |   |   +-- url-validator.ts      # SSRF prevention + allowlist
|   |   |   +-- dns-resolver.ts       # IP validation (block private ranges)
|   |   +-- types/
|   |   |   +-- api.types.ts          # Request/response types
|   |   |   +-- job.types.ts          # Internal job types
|   |   |   +-- events.types.ts       # Webhook event types
|   |   +-- config.ts                 # Zod-validated environment config
|   |
|   +-- notifier/
|   |   +-- webhook-notifier.ts       # POST results to callback URLs
|   |
|   +-- scheduler/
|       +-- stale-job-sweeper.ts      # Recover stuck jobs
|       +-- storage-gc.ts            # Clean old screenshot files
|
+-- docker/
|   +-- Dockerfile                    # Multi-stage build with Playwright deps
|   +-- docker-compose.yml            # Local dev (API + worker + postgres + localstack)
|
+-- tests/
|   +-- unit/                         # Pure function tests
|   +-- integration/                  # API + DB tests
|   +-- e2e/                          # Full pipeline tests
|
+-- docs/
|   +-- api.md                        # API documentation
|   +-- architecture.md               # Architecture overview
|   +-- runbook.md                    # Operations runbook
|
+-- package.json
+-- tsconfig.json
+-- drizzle.config.ts
+-- .env.example
```

---

## 15. Integration (Consumption Pattern)

Any client (dashboard, internal API, CI/CD pipeline) consumes SCS via REST API.

### 15.1. Recommended fallback chain in the UI

```
1. Screenshot available (WebP)                      -> show preview image
2. Capture in progress (status=running/queued)      -> skeleton + "Generating preview..."
3. Capture failed / does not exist                  -> default image for the entity type
4. No image available                               -> generic SVG placeholder
```

### 15.2. Consumption pattern

1. Query `GET /v1/entities/:entity_type/:entity_id/screenshots` to get the image URL
2. If no screenshot exists: optionally trigger `POST /v1/captures` and poll
3. If status is `queued` or `running`: poll `GET /v1/captures/:job_id` every 5s until `succeeded` or `failed`
4. Images served via CDN — consumer uses the `image_url` directly as `<img src>`

### 15.3. Integration example

```typescript
// Fetch screenshot for a template
const response = await fetch('/v1/entities/template/sol-12345/screenshots', {
  headers: { 'X-Api-Key': API_KEY }
})

const data = await response.json()

if (data.screenshots.length > 0) {
  // Has screenshot -> use the CDN URL
  const cardPreview = data.screenshots.find(s => s.viewport === 'card')
  imageElement.src = cardPreview.image_url
} else {
  // No screenshot -> trigger capture
  await fetch('/v1/captures', {
    method: 'POST',
    headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: templateDemoUrl,
      entity_type: 'template',
      entity_id: 'sol-12345'
    })
  })
  // Show skeleton while capturing
  imageElement.src = '/placeholders/generating-preview.svg'
}
```

---

## 16. Alternatives Considered

### 16.1. Serverless Functions (Lambda/Edge Functions) for capture

| Pros | Cons |
|------|------|
| Zero infra to manage | Chromium (~400MB) does not fit in Edge Functions (V8 isolates) |
| Scale to zero | Cold start of 10-15s to load the browser |
| Pay-per-use | Maximum timeout of 30-60s (tight for capture + processing) |
| | No browser reuse between invocations (each call = cold start) |

**Decision:** Discarded. Headless browsers need dedicated containers with sufficient memory and benefit enormously from a warm pool.

### 16.2. Third-party service (Screenshotlayer, URLBox, etc.)

| Pros | Cons |
|------|------|
| Zero development | External dependency |
| Ready to use | Cost per screenshot ($0.01-0.05 each) |
| | No control over quality/timing |
| | Data (URLs) leaves the SCS infrastructure |
| | Additional latency |

**Decision:** Discarded. High volume, need for fine control over quality, and internal URLs must stay within SCS infrastructure.

### 16.3. Client-side capture (user's browser)

| Pros | Cons |
|------|------|
| Zero backend infra | Depends on the user opening the dashboard |
| | Inconsistent quality |
| | Does not work for automation |
| | CORS issues with template URLs |

**Decision:** Discarded. Does not meet the automation and consistency requirements.

### 16.4. Puppeteer instead of Playwright

| Pros | Cons |
|------|------|
| Larger community | Chrome only |
| Lighter | Manual waits (no reliable native networkidle) |
| | Less isolated browser contexts |
| | Less active maintenance |

**Decision:** Playwright is preferred for stability, native waits, and better context management.

### 16.5. Redis/BullMQ instead of SQS

| Pros | Cons |
|------|------|
| More control (priority, delay, rate limiting) | Additional infra to manage (Redis) |
| Built-in dashboard (Bull Board) | Not serverless |
| Better for complex jobs | One more point of failure |

**Decision:** SQS for the MVP and v1.0 for simplicity. BullMQ may be considered if we need advanced queue features (granular priority, dependent jobs).

---

## 17. Phased Rollout

### MVP

| Item | Description |
|------|-------------|
| **Scope** | API + inline worker (same process), template only, card viewport, SQLite, 1 container |
| **Deliverables** | `POST/GET /v1/captures`, `GET /v1/screenshots`, deploy via Docker on EC2/ECS |
| **Validation** | Capture screenshots of 10 real templates, verify visual quality |
| **Success criteria** | >80% of captures without blank page; images served via CDN in <500ms |

### v1.0

| Item | Description |
|------|-------------|
| **Scope** | PostgreSQL, SQS, separate worker with browser pool, webhook receiver, bulk endpoint |
| **Deliverables** | Backfill of all existing templates; integration with template CI/CD |
| **Validation** | Full backfill of 500+ templates; zero downtime during deploy |
| **Success criteria** | >90% success rate; P95 < 15s per capture |

### v1.1

| Item | Description |
|------|-------------|
| **Scope** | Entity types application + deployment; detail and OG viewports; callback notifications |
| **Deliverables** | Integration with deploy pipeline; previews in 3 sizes |
| **Validation** | Preview generated automatically in <30s after deploy finishes |

### v2.0

| Item | Description |
|------|-------------|
| **Scope** | Autoscaling, full Prometheus metrics, DLQ dashboard, scheduled recapture (cron) |
| **Deliverables** | Observability dashboard; configured alerts; automated GC |

---

## 18. Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| High rate of blank pages | Medium | High | Wait strategy escalation; pixel variance analysis; retry with different strategies |
| Chromium memory leaks | High | Medium | Browser recycling after N captures; container memory limits; RSS monitoring |
| SSRF via malicious URLs | Low | Critical | Strict allowlist; DNS rebinding protection; browser sandbox |
| Infrastructure cost (heavy containers) | Medium | Medium | Aggressive downscaling; scale to 2 workers when idle |
| Template URLs go offline | Medium | Low | Retry with backoff; keep last valid screenshot (is_latest does not change on failure) |
| Chromium updates break captures | Low | High | Pin Playwright version; e2e tests before upgrade; fast rollback |

---

## 19. Open Decisions

| # | Decision | Options | Owner |
|---|----------|---------|-------|
| 1 | Screenshots CDN domain | `screenshots.example.com` vs subpath of existing CDN | Infra |
| 2 | Initial URL allowlist | Only `*.example.app` or include customer custom domains? | Product |
| 3 | SQS vs BullMQ for queue | Simplicity (SQS) vs control (BullMQ) | Engineering |
| 4 | Fallback SVG placeholder | Use a generic design or create one per entity_type? | Design |
| 5 | Automatic recapture frequency | Only on-publish or periodic cron (weekly)? | Product |
| 6 | Support for customer custom domains | Phase v1.1 or v2.0? SSRF implications | Security + Product |
| 7 | Orchestration: ECS vs Kubernetes | Depends on current SCS infrastructure | Infra/DevOps |
