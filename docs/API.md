# Screenshot Capture Service — API Documentation

## Overview

The Screenshot Capture Service (SCS) is an asynchronous API that captures screenshots of web pages. It manages a job queue, handles retries, and stores screenshots in S3-compatible storage (or local filesystem for development).

**Base URL**: `http://localhost:3000` (development)

---

## Authentication

### API Key (most endpoints)

All endpoints under `/v1/` (except `/v1/events`) require an API key sent via the `X-API-Key` header.

```
X-API-Key: your-api-key
```

If the key is missing or invalid, the API returns `401 Unauthorized`.

### Webhook HMAC-SHA256 (`/v1/events` only)

The `/v1/events` endpoint uses HMAC-SHA256 signature verification instead of API key auth. The signature must be sent via the `X-Webhook-Signature` header.

To generate the signature:
```bash
echo -n '{"event_type":"template.published","entity_type":"template","entity_id":"my-template","url":"https://example.com"}' \
  | openssl dgst -sha256 -hmac "your-webhook-secret" | awk '{print $2}'
```

---

## Rate Limiting

- **Limit**: 60 requests per 60-second window
- **Key**: Identified by `X-API-Key` header (or IP address if no key)
- **Exceeded response**: `429 Too Many Requests` with `Retry-After` header (seconds)

```json
{
  "error": "rate_limit_exceeded",
  "message": "Too many requests. Retry after 45 seconds."
}
```

---

## Error Format

All errors follow a consistent format:

```json
{
  "error": "error_code",
  "message": "Human-readable description"
}
```

Common error codes:
| Code | HTTP Status | Description |
|------|-------------|-------------|
| `validation_error` | 400 | Invalid request body or parameters |
| `unauthorized` | 401 | Missing or invalid authentication |
| `url_not_allowed` | 403 | URL is not in the allowlist or resolves to a private IP |
| `not_found` | 404 | Resource not found |
| `rate_limit_exceeded` | 429 | Too many requests |
| `internal_error` | 500 | Unexpected server error |

---

## Endpoints

### POST /v1/captures

Creates a single screenshot capture job.

**Authentication**: API Key

**Request Body**:
```json
{
  "url": "https://example.com",
  "entity_type": "template",
  "entity_id": "my-template-123",
  "callback_url": "https://your-server.com/webhook",
  "options": {
    "viewports": ["card", "detail"],
    "wait_strategy": "networkidle",
    "wait_selector": "#main-content",
    "wait_timeout_ms": 15000,
    "delay_after_load_ms": 2000
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `url` | string | Yes | - | HTTPS URL to capture (must be in allowlist) |
| `entity_type` | string | Yes | - | One of: `template`, `application`, `deployment` |
| `entity_id` | string | Yes | - | Unique identifier for the entity (1-255 chars) |
| `callback_url` | string | No | - | HTTPS URL to receive completion/failure notifications |
| `options.viewports` | string[] | No | `["card"]` | Viewport presets: `card` (1366x768), `detail` (1280x800) |
| `options.wait_strategy` | string | No | `"networkidle"` | Page load strategy: `networkidle`, `domcontentloaded`, `load` |
| `options.wait_selector` | string | No | - | CSS selector to wait for before capturing |
| `options.wait_timeout_ms` | number | No | `15000` | Navigation timeout (1000-60000 ms) |
| `options.delay_after_load_ms` | number | No | `2000` | Extra delay after page load (0-10000 ms) |

**Response** `202 Accepted`:
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued",
  "created_at": "2025-01-15T10:30:00.000Z",
  "estimated_completion_seconds": 30
}
```

If a capture job already exists for the same entity (deduplication):
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "running",
  "created_at": "2025-01-15T10:29:55.000Z",
  "estimated_completion_seconds": 30,
  "deduplicated": true
}
```

**Error Responses**: `400`, `401`, `403`, `429`

---

### POST /v1/captures/bulk

Creates multiple capture jobs in a single request (1-100 items).

**Authentication**: API Key

**Request Body**:
```json
{
  "items": [
    {
      "url": "https://example.com/page-1",
      "entity_type": "template",
      "entity_id": "template-001"
    },
    {
      "url": "https://example.com/page-2",
      "entity_type": "application",
      "entity_id": "app-002"
    }
  ],
  "priority": "high"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `items` | array | Yes | - | Array of capture items (1-100) |
| `items[].url` | string | Yes | - | HTTPS URL to capture |
| `items[].entity_type` | string | Yes | - | Entity type |
| `items[].entity_id` | string | Yes | - | Entity identifier |
| `priority` | string | No | `"high"` | Queue priority: `high` or `low` |

**Response** `202 Accepted`:
```json
{
  "batch_id": "660e8400-e29b-41d4-a716-446655440001",
  "total_jobs": 2,
  "skipped": 0,
  "status": "queued"
}
```

Items are skipped if: URL fails validation or a capture job already exists for the entity.

**Error Responses**: `400`, `401`, `429`

---

### GET /v1/captures/:job_id

Gets the status and results of a capture job.

**Authentication**: API Key

**Path Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `job_id` | string (UUID) | The job ID returned by POST /v1/captures |

**Response** `200 OK` (completed job):
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "succeeded",
  "url": "https://example.com",
  "entity_type": "template",
  "entity_id": "my-template-123",
  "attempts": 1,
  "created_at": "2025-01-15T10:30:00.000Z",
  "started_at": "2025-01-15T10:30:01.000Z",
  "completed_at": "2025-01-15T10:30:15.000Z",
  "results": [
    {
      "viewport": "card",
      "image_url": "https://cdn.example.com/screenshots/template/my-template-123/card-1366x768-v1705312200.webp",
      "width": 1366,
      "height": 768,
      "format": "webp",
      "file_size_bytes": 45230
    }
  ]
}
```

**Response** `200 OK` (failed job):
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "failed",
  "url": "https://example.com",
  "entity_type": "template",
  "entity_id": "my-template-123",
  "attempts": 3,
  "created_at": "2025-01-15T10:30:00.000Z",
  "started_at": "2025-01-15T10:30:01.000Z",
  "completed_at": "2025-01-15T10:35:00.000Z",
  "error": {
    "code": "timeout",
    "message": "Navigation timeout of 15000ms exceeded"
  },
  "results": []
}
```

**Error Responses**: `401`, `404`, `429`

---

### GET /v1/entities/:entity_type/:entity_id/screenshots

Gets the latest screenshots for an entity.

**Authentication**: API Key

**Path Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `entity_type` | string | One of: `template`, `application`, `deployment` |
| `entity_id` | string | Entity identifier |

**Response** `200 OK`:
```json
{
  "entity_type": "template",
  "entity_id": "my-template-123",
  "latest_capture_at": "2025-01-15T10:30:15.000Z",
  "screenshots": [
    {
      "viewport": "card",
      "image_url": "https://cdn.example.com/screenshots/template/my-template-123/card-1366x768-v1705312200.webp",
      "width": 1366,
      "height": 768,
      "format": "webp",
      "file_size_bytes": 45230
    },
    {
      "viewport": "detail",
      "image_url": "https://cdn.example.com/screenshots/template/my-template-123/detail-1280x800-v1705312200.webp",
      "width": 1280,
      "height": 800,
      "format": "webp",
      "file_size_bytes": 52100
    }
  ]
}
```

Returns empty `screenshots` array if no screenshots exist.

**Error Responses**: `400`, `401`, `429`

---

### DELETE /v1/entities/:entity_type/:entity_id/screenshots

Deletes all screenshots for an entity (both storage files and database records).

**Authentication**: API Key

**Path Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `entity_type` | string | One of: `template`, `application`, `deployment` |
| `entity_id` | string | Entity identifier |

**Response**: `204 No Content`

**Error Responses**: `400`, `401`, `429`

---

### POST /v1/events

Webhook receiver for external events that trigger automatic captures.

**Authentication**: HMAC-SHA256 signature via `X-Webhook-Signature` header

**Request Body**:
```json
{
  "event_type": "template.published",
  "entity_type": "template",
  "entity_id": "my-template-123",
  "url": "https://example.com/preview/my-template-123",
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event_type` | string | Yes | One of: `template.published`, `template.updated`, `deployment.finished`, `manual.trigger` |
| `entity_type` | string | Yes | One of: `template`, `application`, `deployment` |
| `entity_id` | string | Yes | Entity identifier |
| `url` | string | Yes | URL to capture |
| `timestamp` | string | No | Event timestamp (ISO 8601) |

Viewport selection based on event type:
- `template.published` / `template.updated`: captures both `card` and `detail` viewports
- `deployment.finished` / `manual.trigger`: captures `card` viewport only

**Response** `202 Accepted`:
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued",
  "created_at": "2025-01-15T10:30:00.000Z",
  "estimated_completion_seconds": 30
}
```

**Error Responses**: `400`, `401`, `403`

---

### GET /healthz

Liveness probe. Returns `200` if the server is running.

**Authentication**: None

**Response** `200 OK`:
```json
{
  "status": "ok"
}
```

---

### GET /readyz

Readiness probe. Checks database connectivity.

**Authentication**: None

**Response** `200 OK`:
```json
{
  "status": "ok",
  "db": "connected"
}
```

**Response** `503 Service Unavailable`:
```json
{
  "status": "degraded",
  "db": "disconnected"
}
```

---

### GET /metrics

Prometheus-format metrics endpoint.

**Authentication**: None

**Response** `200 OK` (`text/plain`):
```
# HELP scs_jobs_total Total capture jobs by status
# TYPE scs_jobs_total gauge
scs_jobs_total{status="queued"} 5
scs_jobs_total{status="running"} 2
scs_jobs_total{status="succeeded"} 150
scs_jobs_total{status="failed"} 3
```

---

## Callback Notifications

When a job has a `callback_url`, the service sends a POST request upon completion or failure.

The callback payload is signed with HMAC-SHA256 using the `WEBHOOK_SECRET`. The signature is sent in the `X-Webhook-Signature` header.

### Success Callback

```json
{
  "event": "capture.completed",
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "succeeded",
  "entity_type": "template",
  "entity_id": "my-template-123",
  "screenshots": [
    {
      "viewport": "card",
      "image_url": "https://cdn.example.com/screenshots/...",
      "width": 1366,
      "height": 768,
      "format": "webp"
    }
  ]
}
```

### Failure Callback

```json
{
  "event": "capture.failed",
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "failed",
  "entity_type": "template",
  "entity_id": "my-template-123",
  "error": {
    "code": "timeout",
    "message": "Navigation timeout of 15000ms exceeded"
  },
  "screenshots": []
}
```

Callback timeout: 10 seconds. Failed callbacks are logged but not retried.

---

## Job Lifecycle

```
                     ┌──────────┐
                     │  queued   │◄─────────────────┐
                     └────┬─────┘                   │
                          │ claimed by worker        │ retry (with delay)
                          ▼                          │
                     ┌──────────┐              ┌─────┴─────┐
                     │ running  │──── error ──►│  classify  │
                     └────┬─────┘              │   error    │
                          │ screenshots done   └─────┬─────┘
                          ▼                          │ non-retryable
                ┌──────────────────┐                 │ or max attempts
                │processing_images │                 ▼
                └────────┬─────────┘           ┌──────────┐
                         │ upload complete      │  failed  │
                         ▼                     └──────────┘
                    ┌──────────┐
                    │succeeded │
                    └──────────┘
```

### Job Statuses

| Status | Description |
|--------|-------------|
| `queued` | Waiting to be picked up by a worker |
| `running` | Currently being processed (browser navigating, capturing) |
| `processing_images` | Screenshots captured, uploading to storage |
| `succeeded` | All screenshots captured and stored successfully |
| `failed` | Job failed permanently (non-retryable error or max attempts reached) |
| `cancelled` | Job was cancelled (reserved for future use) |

### Error Codes

| Code | Retryable | Description |
|------|-----------|-------------|
| `timeout` | Yes | Page navigation or loading timed out |
| `dns_failure` | Yes | DNS resolution failed |
| `connection_refused` | Yes | Target server refused connection |
| `blank_page` | Yes | Page rendered as blank (low visual entropy) |
| `http_5xx` | Yes | Target server returned a 5xx error |
| `browser_crash` | Yes | Chromium browser process crashed |
| `ssl_error` | No | SSL/TLS certificate error |
| `http_4xx` | No | Target server returned 403 or 404 |
| `blocked_by_firewall` | No | Request blocked by network firewall |
| `url_not_allowed` | No | URL not in the configured allowlist |
| `internal_error` | Yes (1 retry) | Unexpected internal error |

---

## Configuration

All configuration is via environment variables.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | HTTP server port |
| `HOST` | No | `0.0.0.0` | HTTP server bind address |
| `NODE_ENV` | No | `production` | Environment: `development`, `production`, `test` |
| `API_KEY` | Yes | - | API key for authenticating requests |
| `WEBHOOK_SECRET` | Yes | - | Secret for HMAC-SHA256 webhook signatures |
| `S3_ENDPOINT` | No | - | S3-compatible storage endpoint URL |
| `S3_REGION` | No | `us-east-1` | S3 region |
| `S3_BUCKET` | No* | - | S3 bucket name (*required if S3_ENDPOINT is set) |
| `S3_ACCESS_KEY_ID` | No* | - | S3 access key (*required if S3_ENDPOINT is set) |
| `S3_SECRET_ACCESS_KEY` | No* | - | S3 secret key (*required if S3_ENDPOINT is set) |
| `CDN_BASE_URL` | No* | - | CDN base URL for screenshot URLs (*required if S3_ENDPOINT is set) |
| `USE_LOCAL_STORAGE` | No | `false` | Use local filesystem instead of S3 |
| `DB_PATH` | No | `./data/scs.db` | SQLite database file path |
| `CAPTURE_TIMEOUT_MS` | No | `30000` | Default page navigation timeout |
| `CAPTURE_DELAY_AFTER_LOAD_MS` | No | `2000` | Default delay after page load |
| `MAX_CONCURRENT_CAPTURES` | No | `3` | Maximum concurrent screenshot captures |
| `BROWSER_RECYCLE_AFTER` | No | `10` | Recycle Chromium browser after N captures |
| `URL_ALLOWLIST_PATTERNS` | No | `.*` | Comma-separated regex patterns for allowed hostnames |
