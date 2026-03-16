# Screenshot Capture Service

Servico de captura automatizada de screenshots de URLs via headless browser. Recebe uma URL, gera previews em resolucoes configuradas (notebook, desktop, Open Graph) e armazena as imagens em storage S3-compatible ou filesystem local.

## Arquitetura

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

| Componente | Tecnologia |
|---|---|
| API | Fastify 5 (~75k req/s) |
| Browser | Playwright + Chromium |
| Imagens | Sharp (PNG -> WebP, quality 80) |
| Database | SQLite via better-sqlite3 (WAL mode) |
| Storage | S3-compatible ou filesystem local |
| Validacao | Zod |
| Logs | Pino (JSON structured) |
| Runtime | Node.js 20+ |

## Quick Start

```bash
# Instalar dependencias
npm install

# Instalar browser do Playwright
npx playwright install chromium

# Copiar config
cp .env.example .env

# Rodar em dev
npm run dev
```

## Uso

### Capturar screenshot

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

Resposta:
```json
{
  "job_id": "abc-123-...",
  "status": "queued",
  "estimated_completion_seconds": 30
}
```

### Consultar resultado

```bash
curl http://localhost:3000/v1/captures/<job_id> \
  -H "X-API-Key: dev-api-key"
```

### Testes via VSCode

Abra `requests.http` com a extensao [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client) e clique em "Send Request".

## Endpoints

| Metodo | Endpoint | Descricao |
|---|---|---|
| `POST` | `/v1/captures` | Criar job de captura |
| `POST` | `/v1/captures/bulk` | Criar ate 100 jobs em lote |
| `GET` | `/v1/captures/:job_id` | Consultar status e resultado |
| `GET` | `/v1/entities/:type/:id/screenshots` | Listar screenshots de uma entidade |
| `DELETE` | `/v1/entities/:type/:id/screenshots` | Deletar screenshots |
| `POST` | `/v1/events` | Webhook receiver (HMAC-signed) |
| `GET` | `/healthz` | Health check |
| `GET` | `/readyz` | Readiness (DB connectivity) |
| `GET` | `/metrics` | Metricas Prometheus |

## Viewports

| Nome | Resolucao | Uso |
|---|---|---|
| `card` | 1366x768 | Preview (tela de notebook) |
| `detail` | 1280x800 | Pagina de detalhe |

## Configuracao

Variaveis de ambiente (ver `.env.example`):

| Variavel | Default | Descricao |
|---|---|---|
| `PORT` | 3000 | Porta do servidor |
| `API_KEY` | - | Chave de autenticacao (obrigatoria) |
| `CAPTURE_TIMEOUT_MS` | 30000 | Timeout de navegacao |
| `CAPTURE_DELAY_AFTER_LOAD_MS` | 2000 | Delay apos carregamento da pagina |
| `MAX_CONCURRENT_CAPTURES` | 3 | Capturas paralelas simultaneas |
| `BROWSER_RECYCLE_AFTER` | 10 | Reciclar browser a cada N capturas |
| `USE_LOCAL_STORAGE` | false | Salvar em disco ao inves de S3 |
| `URL_ALLOWLIST_PATTERNS` | `.*` | Regex de URLs permitidas |

## Performance

- **Fastify** em vez de Express (~5x mais rapido para HTTP)
- **Worker pool** com capturas paralelas (configuravel via `MAX_CONCURRENT_CAPTURES`)
- **SQLite otimizado**: WAL mode, 64MB cache, memory-mapped I/O (256MB)
- **Browser pooling**: reutiliza instancia Chromium entre capturas
- **Blank page detection**: evita salvar screenshots vazios, re-tenta com scroll

## Docker

```bash
docker compose -f docker/docker-compose.yml up
```

## Estrutura do Projeto

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

## Licenca

MIT
