# Screenshot Capture Service

Automated URL screenshot capture service via headless browser. Receives a URL, generates previews at configurable resolutions (laptop, desktop, Open Graph) and stores the images in S3-compatible storage or local filesystem.

## Architecture

```
                    POST /v1/captures
                          |
                    +-----v------+
                    |  Fastify   |  API + Auth + Rate Limit
                    |  REST API  |
                    +-----+------+
                          |
                    +-----v------+
                    |  SQLite    |  Job queue (WAL mode)
                    |  Queue     |  Priority-based, deduplication
                    +-----+------+
                          |
                    +-----v------+
                    |  Worker    |  Parallel processing (N concurrent)
                    |  Pool      |
                    +-----+------+
                          |
              +-----------+-----------+
              |                       |
        +-----v------+         +-----v------+
        | Playwright |         |   Sharp    |
        | Chromium   |         |   Image    |
        | Headless   |         |   Processing
        +-----+------+         +-----+------+
              |                       |
              +-----------+-----------+
                          |
                    +-----v------+
                    |  Storage   |  S3 / Local filesystem
                    +------------+
```

## Stack

| Component | Technology |
|---|---|
| API | Fastify 5 (~75k req/s) |
| Browser | Playwright + Chromium |
| Images | Sharp (PNG -> WebP, quality 80) |
| Database | SQLite via better-sqlite3 (WAL mode) |
| Storage | S3-compatible or local filesystem |
| Validation | Zod |
| Logging | Pino (JSON structured) |
| Runtime | Node.js 20+ |

## Quick Start

```bash
# Install dependencies
npm install

# Install Playwright browser
npx playwright install chromium

# Copy config
cp .env.example .env

# Run in dev mode
npm run dev
```

## Usage

### Capture a screenshot

```bash
curl -X POST http://localhost:3000/v1/captures \
  -H "Content-Type: application/json" \
  -H "X-API-Key: dev-api-key" \
  -d '{
    "url": "https://github.com",
    "entity_type": "application",
    "entity_id": "github-home",
    "options": {
      "viewports": ["card"],
      "wait_strategy": "domcontentloaded",
      "delay_after_load_ms": 3000
    }
  }'
```

Response:
```json
{
  "job_id": "abc-123-...",
  "status": "queued",
  "estimated_completion_seconds": 30
}
```

### Check result

```bash
curl http://localhost:3000/v1/captures/<job_id> \
  -H "X-API-Key: dev-api-key"
```

### Testing via VSCode

Open `requests.http` with the [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client) extension and click "Send Request".

## Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/v1/captures` | Create a capture job |
| `POST` | `/v1/captures/bulk` | Create up to 100 jobs in batch |
| `GET` | `/v1/captures/:job_id` | Check job status and results |
| `GET` | `/v1/entities/:type/:id/screenshots` | List screenshots for an entity |
| `DELETE` | `/v1/entities/:type/:id/screenshots` | Delete screenshots |
| `POST` | `/v1/events` | Webhook receiver (HMAC-signed) |
| `GET` | `/healthz` | Health check |
| `GET` | `/readyz` | Readiness (DB connectivity) |
| `GET` | `/metrics` | Prometheus metrics |

## Viewports

| Name | Resolution | Use |
|---|---|---|
| `card` | 1366x768 | Preview (laptop screen) |
| `detail` | 1280x800 | Detail page |

## Configuration

Environment variables (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `PORT` | 3000 | Server port |
| `API_KEY` | - | Authentication key (required) |
| `CAPTURE_TIMEOUT_MS` | 30000 | Navigation timeout |
| `CAPTURE_DELAY_AFTER_LOAD_MS` | 2000 | Delay after page load |
| `MAX_CONCURRENT_CAPTURES` | 3 | Simultaneous parallel captures |
| `BROWSER_RECYCLE_AFTER` | 10 | Recycle browser every N captures |
| `USE_LOCAL_STORAGE` | false | Save to disk instead of S3 |
| `URL_ALLOWLIST_PATTERNS` | `.*` | Allowed URL regex patterns |

## Performance

- **Fastify** instead of Express (~5x faster for HTTP)
- **Worker pool** with parallel captures (configurable via `MAX_CONCURRENT_CAPTURES`)
- **Optimized SQLite**: WAL mode, 64MB cache, memory-mapped I/O (256MB)
- **Browser pooling**: reuses Chromium instance between captures
- **Blank page detection**: avoids saving empty screenshots, retries with scroll

## Docker

```bash
docker compose -f docker/docker-compose.yml up
```

## Project Structure

```
src/
├── index.ts                     # Entry point
├── api/
│   ├── server.ts                # Fastify setup + auth hooks
│   ├── middleware/auth.ts       # API key + HMAC webhook auth
│   └── routes/
│       ├── captures.ts          # POST/GET captures
│       ├── entities.ts          # GET/DELETE entity screenshots
│       ├── events.ts            # Webhook receiver
│       └── health.ts            # Health + metrics
├── worker/
│   ├── job-processor.ts         # Queue polling + retry logic
│   └── capture-engine.ts        # Playwright browser + capture
├── processing/
│   └── storage-uploader.ts      # S3 / local storage
└── shared/
    ├── config.ts                # Zod-validated env config
    ├── db/database.ts           # SQLite layer
    ├── security/url-validator.ts
    └── types/
        ├── job.types.ts
        └── api.types.ts
```

## License

MIT
