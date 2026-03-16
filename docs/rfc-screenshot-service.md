# RFC: Screenshot Capture Service (SCS)

| Campo | Valor |
|-------|-------|
| **Status** | Draft |
| **Autor** | SCS Engineering |
| **Data** | 2026-03-16 |
| **Tipo** | Design Doc |
| **Área** | Platform Services |

---

## Sumário

- [1. Contexto e Problema](#1-contexto-e-problema)
- [2. O que é Headless Browser](#2-o-que-é-headless-browser)
- [3. Proposta — MVP (Solução Simples)](#3-proposta--mvp-solução-simples)
- [4. Proposta — Solução Completa](#4-proposta--solução-completa)
- [5. API Contract](#5-api-contract)
- [6. Data Model](#6-data-model)
- [7. Pipeline de Processamento](#7-pipeline-de-processamento)
- [8. Storage e CDN](#8-storage-e-cdn)
- [9. Segurança](#9-segurança)
- [10. Scaling e Resource Management](#10-scaling-e-resource-management)
- [11. Observabilidade](#11-observabilidade)
- [12. Retry e Failure Handling](#12-retry-e-failure-handling)
- [13. Stack Recomendada](#13-stack-recomendada)
- [14. Estrutura do Projeto](#14-estrutura-do-projeto)
- [15. Integração (Padrão de Consumo)](#15-integração-padrão-de-consumo)
- [16. Alternativas Consideradas](#16-alternativas-consideradas)
- [17. Rollout em Fases](#17-rollout-em-fases)
- [18. Riscos e Mitigações](#18-riscos-e-mitigações)
- [19. Decisões em Aberto](#19-decisões-em-aberto)

---

## 1. Contexto e Problema

### Problema

A SCS oferece um catálogo de templates (Marketplace) cujas demos são publicadas em URLs edge (ex: `*.example.app`). Atualmente, a única representação visual de um template é o **ícone do vendor** (40x40px) — não há preview real do que o template produz. A equipe de Integrations precisa subir imagens de preview manualmente, o que:

- Não escala com o crescimento do catálogo
- Fica desatualizado quando o template é republished
- Depende de esforço manual recorrente

### Oportunidade

Além de templates, o mesmo problema se aplica a **deploys de aplicações de clientes** (import from GitHub, edge applications). Ter previews automáticos melhora a experiência do dashboard e alinha a SCS com o que Vercel e Netlify já oferecem.

### Benchmarks

| Plataforma | O que fazem |
|-----------|-------------|
| **Vercel** | Exibe screenshots do último production deployment no dashboard para dar "quick glimpse" dos projetos |
| **Netlify** | Usa headless browser após cada deploy para gerar thumbnail de sites no dashboard |

### Objetivo

Criar um **serviço standalone da SCS** que:
1. Recebe uma URL e gera automaticamente uma imagem de preview via headless browser
2. Armazena a imagem em Edge Storage e serve via CDN
3. Suporta múltiplos tipos de entidade (template, application, deployment)
4. Regera screenshots automaticamente quando a entidade é atualizada
5. É reutilizável para qualquer produto da SCS que precise de previews de URL

---

## 2. O que é Headless Browser

Um **headless browser** é um navegador web (como Chrome/Chromium) que roda **sem interface gráfica** — ou seja, sem abrir uma janela visível. Ele executa tudo que um browser normal faz (renderiza HTML, CSS, executa JavaScript, carrega imagens, faz requests de rede), mas em modo "invisível" no servidor.

### Por que é necessário para screenshots?

Sites modernos (SPAs como React, Vue, Angular) renderizam conteúdo via JavaScript — não basta fazer um simples HTTP GET no HTML. O headless browser:

1. Executa o JavaScript completo da página
2. Espera o DOM ficar pronto (incluindo lazy loading, API calls)
3. Renderiza o layout visual (CSS, imagens, fontes)
4. "Tira a foto" da página renderizada

### Ferramentas disponíveis

| Ferramenta | Descrição | Prós | Contras |
|-----------|-----------|------|---------|
| **Playwright** | Framework da Microsoft para automação de browsers | Waits nativos, multi-browser, API moderna, mais estável | Ligeiramente mais pesado |
| **Puppeteer** | Framework do Google para automação do Chrome | Mais leve, comunidade grande | Apenas Chrome, waits manuais |

### Exemplo simplificado (Playwright)

```typescript
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage()

// Define o tamanho da "tela"
await page.setViewportSize({ width: 1280, height: 800 })

// Navega e espera o carregamento completo
await page.goto('https://template.example.app', { waitUntil: 'networkidle' })

// Captura a screenshot
const screenshot = await page.screenshot({ type: 'png' })
// screenshot é um Buffer com a imagem da página renderizada

await browser.close()
```

### Trade-off de recursos

Headless browsers consomem bastante recursos:
- **Memória:** ~200-400MB por instância do browser
- **CPU:** picos durante renderização de páginas complexas
- **Tempo:** 5-15 segundos por captura (navegação + renderização + screenshot)

Por isso, o serviço precisa de gerenciamento cuidadoso de pool de browsers e containers dedicados com recursos suficientes.

---

## 3. Proposta — MVP (Solução Simples)

O MVP foca em **resolver o problema imediato**: gerar previews de templates automaticamente, com o mínimo de infraestrutura.

### Escopo MVP

- **1 entity type:** template only
- **1 viewport:** card (400 x 300 px)
- **1 formato de saída:** WebP
- **Trigger:** API call manual ou via CI/CD do template publish
- **Sem message queue** — processamento inline com job runner simples
- **Sem webhook/callback** — clientes fazem polling do status

### Arquitetura MVP

```
Clientes / CI Pipeline
        |
   POST /v1/captures
        |
  +-----v-----------+
  | API (Fastify)    |
  | + Worker inline  |  ← mesmo processo, sem fila separada
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

### Decisões de simplificação do MVP

| Área | Decisão MVP | Justificativa |
|------|------------|---------------|
| Processo | API e worker no mesmo container | Evita complexidade de infraestrutura; 1 container para deploy e operar |
| Database | SQLite (better-sqlite3) | Zero configuração, embedded, suficiente para centenas de registros |
| Queue | Sem fila — `setImmediate` + polling | Volume baixo (< 50 capturas/dia); fila é over-engineering nessa fase |
| Browser | 1 browser por vez (serial) | Sem concorrência; simplifica gerenciamento de memória |
| Retry | 1 retry com delay fixo (5s) | Suficiente para falhas transientes; erros persistentes vão para `failed` |
| Viewports | Apenas card (400x300) | Cobre o caso de uso principal (catálogo de templates) |

### API MVP

```
POST /v1/captures
  body: { url, entity_type: "template", entity_id }
  → 202 { job_id, status: "queued" }

GET /v1/captures/:job_id
  → { job_id, status, image_url?, error? }

GET /v1/screenshots/:entity_type/:entity_id
  → { image_url, captured_at }
```

### Stack MVP

| Camada | Tecnologia |
|--------|-----------|
| Runtime | Node.js 20 + TypeScript |
| API | Fastify |
| Browser | Playwright (Chromium) |
| Processamento de imagem | Sharp |
| Storage | SCS Edge Storage (S3-compatible) |
| CDN | SCS CDN |
| State | SQLite (better-sqlite3) |
| Deploy | 1 container Docker (ECS ou EC2) |

### Segurança MVP

- URL validation: HTTPS only + allowlist de domínios (`*.example.app`)
- Rate limit básico: 10 req/min global
- Browser sandbox padrão do Playwright (habilitado por default)

### Blank Page Detection MVP

- Wait `networkidle` + 2s delay após load
- 1 retry com 5s delay se pixel variance < threshold (>95% pixels da mesma cor = blank)
- Se falhar após retry: marca como `failed`, sem imagem gerada

### Fluxo MVP (passo a passo)

```
1. CI/CD publica template → chama POST /v1/captures
2. API valida URL (HTTPS + allowlist), cria job no SQLite, inicia captura via setImmediate
3. Playwright abre URL, espera networkidle + 2s, screenshot
4. Sharp converte para WebP 400x300 (quality 80)
5. Upload para Edge Storage: screenshots/template/{entity_id}/card-400x300-v{timestamp}.webp
6. Atualiza job no SQLite com image_url e status=succeeded
7. Cliente faz GET /v1/screenshots/template/{id} → recebe image_url para usar como <img src>
```

### O que o MVP NÃO tem

| Feature | Status | Quando vem |
|---------|--------|-----------|
| Message queue (SQS/BullMQ) | ❌ | v1.0 |
| PostgreSQL | ❌ | v1.0 |
| Múltiplos viewports (detail, og) | ❌ | v1.1 |
| Webhook/callback notifications | ❌ | v1.1 |
| Browser pool | ❌ | v1.0 |
| Bulk endpoint | ❌ | v1.0 |
| Entity types application/deployment | ❌ | v1.1 |
| Métricas Prometheus/alertas | ❌ | v2.0 |
| Stale job sweeper | ❌ | v1.0 |
| Dead letter queue | ❌ | v2.0 |
| Autoscaling | ❌ | v2.0 |

---

## 4. Proposta — Solução Completa

### Arquitetura

```
Clientes (APIs internas, CI/CD, dashboards)
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

### Componentes

| Componente | Responsabilidade | Tecnologia |
|-----------|-----------------|-----------|
| **API Gateway** | Auth, rate limiting, routing | SCS Edge Firewall + Edge Functions |
| **Capture API** | Submissão de jobs, validação, deduplicação | Node.js (Fastify) |
| **Status/Query API** | Consulta de status e screenshots por entidade | Node.js (Fastify) |
| **Message Queue** | Desacoplar submissão da execução, back-pressure | AWS SQS (2 filas: high + low priority) |
| **Worker Pool** | Headless browser capture + retry | Node.js + Playwright |
| **Image Processor** | Resize, conversão de formato, otimização | Sharp (libvips) |
| **Storage** | Persistência com chaves estruturadas | SCS Edge Storage (S3-compatible) |
| **CDN** | Servir imagens globalmente com cache | SCS CDN |
| **Database** | Estado dos jobs, metadados, audit trail | PostgreSQL 16 |
| **Webhook Notifier** | Notificação pós-captura para sistemas interessados | Módulo interno no worker |
| **Scheduler** | Stale job recovery, garbage collection | Cron jobs internos |

### Delta MVP → Completa

| Área | MVP | Completa |
|------|-----|----------|
| Entity types | template only | template, application, deployment |
| Viewports | card (400x300) | card (400x300), detail (1280x800), og (1200x630) |
| Formatos de saída | WebP | WebP + PNG fallback + AVIF |
| State/Database | SQLite | PostgreSQL 16 |
| Queue | Inline (setImmediate) | SQS com 2 filas (high/low priority) |
| Workers | 1 processo, serial | Pool de 2-8 containers, browser pool (3 browsers/container) |
| Retry | 1 retry simples | 3 retries com backoff exponencial + escalada de estratégia |
| Trigger | API manual / CI | Webhooks automáticos (template.published, deployment.finished) |
| Notificação | Polling only | Polling + callback_url webhook |
| Bulk | ❌ | POST /v1/captures/bulk (até 100 items) |
| Observability | Logs básicos (stdout) | Prometheus metrics, alertas, structured logging (OpenTelemetry) |
| Blank detection | 1 estratégia simples | Multi-strategy com escalada (3 tentativas) |
| DLQ | ❌ | Dead letter queue + dashboard de inspeção |
| GC | Manual | Job agendado para cleanup de arquivos antigos (7 dias) |
| Autoscaling | Fixo (1 container) | Queue-depth based (2-8 workers) |

---

## 5. API Contract

### 5.1. POST /v1/captures — Submeter captura

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

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `url` | string (URL) | Sim | URL para capturar. Deve ser HTTPS e estar na allowlist |
| `entity_type` | enum | Sim | `template`, `application`, ou `deployment` |
| `entity_id` | string | Sim | ID da entidade no sistema de origem |
| `callback_url` | string (URL) | Não | URL para POST com resultado após captura |
| `options.viewports` | string[] | Não | Viewports a capturar. Default: `["card"]` |
| `options.wait_strategy` | enum | Não | `networkidle` (default), `domcontentloaded`, `load` |
| `options.wait_selector` | string | Não | CSS selector para esperar antes de capturar |
| `options.wait_timeout_ms` | number | Não | Timeout para wait strategy. Default: 15000 |
| `options.delay_after_load_ms` | number | Não | Delay adicional após load. Default: 2000 |

**Response (202 Accepted):**

```json
{
  "job_id": "job_abc123",
  "status": "queued",
  "created_at": "2026-03-16T10:00:00Z",
  "estimated_completion_seconds": 30
}
```

**Deduplicação:** Se já existe um job `queued` ou `running` para a mesma `entity_type + entity_id`, retorna o `job_id` existente em vez de criar um novo.

### 5.2. GET /v1/captures/:job_id — Status do job

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

| Status | Descrição |
|--------|-----------|
| `queued` | Job na fila, aguardando worker |
| `running` | Worker está executando a captura |
| `processing_images` | Captura concluída, processando/otimizando imagens |
| `succeeded` | Imagens prontas e disponíveis via CDN |
| `failed` | Falha após todos os retries |
| `cancelled` | Job cancelado manualmente |

### 5.3. GET /v1/entities/:entity_type/:entity_id/screenshots — Screenshots por entidade

Retorna os screenshots mais recentes (`is_latest = true`) para uma entidade.

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

### 5.4. POST /v1/captures/bulk — Backfill em lote

Para processamento inicial (backfill) de todos os templates existentes.

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

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `items` | array | Lista de capturas (máx. 100 por request) |
| `priority` | enum | `high` (default) ou `low` (fila de baixa prioridade) |

**Response (202 Accepted):**

```json
{
  "batch_id": "batch_xyz",
  "total_jobs": 2,
  "status": "queued"
}
```

### 5.5. POST /v1/events — Webhook receiver (eventos internos)

Recebe eventos de sistemas internos da SCS para disparar capturas automaticamente.

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

| Event Type | Ação |
|-----------|------|
| `template.published` | Captura/recaptura do preview do template |
| `template.updated` | Recaptura do preview |
| `deployment.finished` | Captura do preview do deploy (futuro) |
| `manual.trigger` | Captura sob demanda |

**Autenticação:** HMAC-SHA256 no header `X-Webhook-Signature` com shared secret.

### 5.6. DELETE /v1/entities/:entity_type/:entity_id/screenshots — Limpar screenshots

Remove todos os screenshots de uma entidade (storage + database).

**Response:** `204 No Content`

### 5.7. Health Checks

```
GET /healthz   → 200 { "status": "ok" }
GET /readyz    → 200 { "status": "ok", "db": "connected", "queue": "connected" }
GET /metrics   → Prometheus text format
```

---

## 6. Data Model

### 6.1. Tabela: capture_jobs

Armazena o estado e metadados de cada job de captura.

| Campo | Tipo | Default | Descrição |
|-------|------|---------|-----------|
| `id` | UUID PK | `gen_random_uuid()` | Identificador único do job |
| `url` | TEXT NOT NULL | — | URL alvo da captura |
| `entity_type` | VARCHAR(50) NOT NULL | — | `template`, `application`, `deployment` |
| `entity_id` | VARCHAR(255) NOT NULL | — | ID da entidade no sistema de origem |
| `status` | VARCHAR(20) NOT NULL | `'queued'` | Estado atual do job |
| `priority` | SMALLINT NOT NULL | `5` | 1 (highest) a 10 (lowest) |
| `attempts` | SMALLINT NOT NULL | `0` | Tentativas realizadas |
| `max_attempts` | SMALLINT NOT NULL | `3` | Máximo de tentativas |
| `options` | JSONB NOT NULL | `'{}'` | Configurações (viewports, wait strategy, timeouts) |
| `callback_url` | TEXT | — | URL para notificação pós-captura |
| `batch_id` | UUID | — | ID do lote (se bulk request) |
| `error_message` | TEXT | — | Mensagem de erro (se failed) |
| `error_code` | VARCHAR(50) | — | Código do erro (`timeout`, `dns_failure`, `blank_page`, etc.) |
| `worker_id` | VARCHAR(100) | — | Identificador do worker que processou |
| `created_at` | TIMESTAMPTZ NOT NULL | `NOW()` | Quando o job foi criado |
| `started_at` | TIMESTAMPTZ | — | Quando o worker iniciou |
| `completed_at` | TIMESTAMPTZ | — | Quando finalizou (sucesso ou falha final) |
| `next_retry_at` | TIMESTAMPTZ | — | Próxima tentativa programada |

**Índices:**
- `(status, priority, created_at) WHERE status = 'queued'` — busca eficiente de próximo job
- `(entity_type, entity_id)` — busca por entidade
- `(batch_id) WHERE batch_id IS NOT NULL` — busca por lote
- `(next_retry_at) WHERE status = 'queued' AND attempts > 0` — jobs de retry

### 6.2. Tabela: screenshots

Armazena os resultados (imagens geradas) de cada captura.

| Campo | Tipo | Default | Descrição |
|-------|------|---------|-----------|
| `id` | UUID PK | `gen_random_uuid()` | Identificador único |
| `job_id` | UUID FK NOT NULL | — | Referência ao capture_job |
| `entity_type` | VARCHAR(50) NOT NULL | — | Denormalizado para query rápida |
| `entity_id` | VARCHAR(255) NOT NULL | — | Denormalizado para query rápida |
| `viewport` | VARCHAR(20) NOT NULL | — | `card`, `detail`, `og` |
| `width` | INT NOT NULL | — | Largura em pixels |
| `height` | INT NOT NULL | — | Altura em pixels |
| `format` | VARCHAR(10) NOT NULL | — | `webp`, `png`, `avif` |
| `storage_key` | TEXT NOT NULL | — | Chave no Edge Storage |
| `cdn_url` | TEXT NOT NULL | — | URL pública via CDN |
| `file_size_bytes` | INT | — | Tamanho do arquivo |
| `is_latest` | BOOLEAN NOT NULL | `TRUE` | Indica se é a versão mais recente |
| `captured_at` | TIMESTAMPTZ NOT NULL | `NOW()` | Timestamp da captura |

**Índices:**
- `(entity_type, entity_id, is_latest) WHERE is_latest = TRUE` — busca do screenshot mais recente
- `UNIQUE (entity_type, entity_id, viewport, format) WHERE is_latest = TRUE` — garante um "latest" por combinação

### 6.3. Tabela: url_allowlist

Controle de segurança — quais domínios/padrões de URL são permitidos.

| Campo | Tipo | Default | Descrição |
|-------|------|---------|-----------|
| `id` | SERIAL PK | — | Identificador |
| `pattern` | TEXT NOT NULL | — | Padrão regex ou glob (ex: `^[\w-]+\.example\.app$`) |
| `description` | TEXT | — | Descrição do padrão |
| `active` | BOOLEAN | `TRUE` | Se o padrão está ativo |
| `created_at` | TIMESTAMPTZ | `NOW()` | Quando foi criado |

### 6.4. Viewport Presets

| Viewport | Largura | Altura | Uso |
|----------|---------|--------|-----|
| `card` | 400 | 300 | Cards do catálogo / lista de templates |
| `detail` | 1280 | 800 | Página de detalhe / modal de preview |
| `og` | 1200 | 630 | Open Graph / compartilhamento em redes sociais |

---

## 7. Pipeline de Processamento

### 7.1. Fluxo completo

```
1. REQUEST chega na API
   │
2. VALIDATE
   ├── URL contra allowlist (prevenção SSRF)
   ├── entity_type é enum válido
   └── Deduplicação: se mesmo entity já tem job queued/running → retorna job_id existente
   │
3. PERSIST job record no banco (status=queued)
   │
4. ENQUEUE mensagem na fila (SQS) com job_id + priority
   │
5. RESPOND 202 com job_id
   │
   ─── fronteira assíncrona ───
   │
6. WORKER consome mensagem da fila
   ├── Atualiza status=running, worker_id, started_at
   │
7. CAPTURE
   ├── a. Obtém browser context do pool (warm, não cold start)
   ├── b. Navega para URL com timeout (30s default)
   ├── c. Aplica wait strategy (networkidle + delay)
   ├── d. Verifica blank page (análise de pixel variance)
   └── e. Captura screenshot para cada viewport configurado
   │
8. BLANK PAGE CHECK
   ├── Se >95% dos pixels são da mesma cor → detectado como "blank"
   ├── Se retries restantes: escalada de estratégia → volta ao passo 7
   └── Se sem retries: marca failed com error_code=blank_page
   │
9. IMAGE PROCESSING (status=processing_images)
   ├── Para cada viewport capturado:
   │   ├── Resize para dimensões exatas (Sharp)
   │   ├── Conversão para WebP (quality 80) + PNG fallback
   │   └── Strip metadata, otimização
   │
10. UPLOAD para Edge Storage
    ├── Key: screenshots/{entity_type}/{entity_id}/{viewport}-{w}x{h}-v{timestamp}.{format}
    └── Headers: Cache-Control: public, max-age=31536000, immutable
    │
11. UPDATE database
    ├── Screenshots anteriores (mesmo entity+viewport): is_latest=false
    ├── Insere novos screenshots com is_latest=true
    └── Atualiza job: status=succeeded, completed_at
    │
12. NOTIFY
    ├── Se callback_url configurado: POST resultado
    └── Emite evento interno para outros sistemas
    │
13. CDN serve imagem via Edge Storage origin
```

### 7.2. Estratégias contra telas em branco

O maior risco de screenshots automáticos é capturar uma tela em branco (loading state, JS não executou, lazy load incompleto). O serviço implementa **escalada progressiva de estratégias**:

| Tentativa | Wait Strategy | Delay após load | Ação extra |
|-----------|--------------|-----------------|-----------|
| 1a | `networkidle` (sem atividade de rede por 500ms) | 2s | — |
| 2a | `waitForSelector('body > *:not(script)')` | 3s | — |
| 3a | `domcontentloaded` | 5s | Scroll down + scroll up (trigger lazy load) |

**Detecção de blank page:**

```typescript
function isBlankPage(screenshotBuffer: Buffer): boolean {
  const image = sharp(screenshotBuffer)
  const { channels } = await image.stats()

  // Se o desvio padrão de todos os canais é muito baixo,
  // a imagem é essencialmente uma cor sólida
  const avgStdDev = channels.reduce((sum, c) => sum + c.stdev, 0) / channels.length
  return avgStdDev < 5  // threshold: quase zero variação = blank
}
```

---

## 8. Storage e CDN

### 8.1. Estrutura de chaves no Edge Storage

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

Cada captura gera uma **nova chave** com timestamp Unix (`v{timestamp}`). A URL da CDN sempre aponta para a chave mais recente (consultada via API). Como a key nunca muda após criação, o CDN pode cachear com `max-age=31536000, immutable` (1 ano).

### 8.3. Garbage collection

Job agendado (diário) que:
1. Busca screenshots com `is_latest = false` e `captured_at < NOW() - INTERVAL '7 days'`
2. Remove os arquivos do Edge Storage
3. Remove os registros do banco

### 8.4. Fallback via Edge Function

Uma Edge Function no domínio `screenshots.example.com` intercepta 404s do storage e retorna um **SVG placeholder genérico** com o texto "Preview not available" — evitando imagens quebradas no frontend.

### 8.5. Bucket e CDN

| Recurso | Valor |
|---------|-------|
| Bucket | `example-screenshots` (Edge Storage) |
| CDN domain | `screenshots.example.com` |
| Origin | Edge Storage bucket |
| Cache TTL | Immutable (1 ano) — key nunca muda |
| Formato primário | WebP (quality 80) |
| Formato fallback | PNG |

---

## 9. Segurança

### 9.1. Prevenção de SSRF (Server-Side Request Forgery)

O principal risco de segurança é um atacante usar o serviço para fazer o headless browser acessar URLs internas da infraestrutura.

**Medidas:**

```typescript
function validateUrl(url: string): boolean {
  const parsed = new URL(url)

  // 1. Deve ser HTTPS
  if (parsed.protocol !== 'https:') return false

  // 2. Deve corresponder a um padrão da allowlist
  const allowedPatterns = await getActivePatterns() // da tabela url_allowlist
  // Ex: /^[\w-]+\.example\.app$/, /^[\w-]+\.exampleedge\.net$/
  if (!allowedPatterns.some(p => p.test(parsed.hostname))) return false

  return true
}
```

**DNS rebinding protection:** No momento da captura, o worker resolve o DNS da URL e verifica se o IP resultante **não está em ranges privados**:

```
Bloqueados: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
            127.0.0.0/8, 169.254.0.0/16, ::1, fc00::/7
```

### 9.2. Sandbox do browser

- Playwright roda com sandbox **habilitado** (default)
- Cada captura usa um **browser context isolado** (cookies, storage, cache separados)
- Acessos bloqueados: filesystem, clipboard, geolocation, notifications, downloads
- Contexto descartado após cada captura

### 9.3. Autenticação

| Tipo de chamada | Método |
|----------------|--------|
| API externa (clientes) | Header `X-Api-Key` validado contra serviço de auth da SCS |
| Webhooks internos (eventos) | HMAC-SHA256 no header `X-Webhook-Signature` com shared secret |
| Worker → Storage | IAM credentials scopadas ao bucket `example-screenshots` (write only) |

### 9.4. Rate Limiting

| Escopo | Limite |
|--------|--------|
| Por API key | 60 requests/minuto |
| Por entidade | 1 captura a cada 5 minutos (deduplicação) |
| Bulk endpoint | 100 items por request |
| Global (todos os workers) | 200 capturas concorrentes |

---

## 10. Scaling e Resource Management

### 10.1. Deployment: 2 tiers de containers

A separação em 2 tiers permite escalar API e workers independentemente:

```
API tier:     2-4 containers leves (512MB RAM, 0.5 vCPU)
              ├── Autoscale: por request count
              └── Muito leve (recebe request, valida, enfileira)

Worker tier:  2-8 containers pesados (2GB RAM, 1 vCPU)
              ├── Autoscale: por queue depth
              └── Pesado (browser + processamento de imagem)
```

### 10.2. Browser Pool (por worker container)

```typescript
const POOL_CONFIG = {
  minBrowsers: 1,           // mínimo sempre ativo
  maxBrowsers: 3,           // máximo por container
  maxPagesPerBrowser: 10,   // reciclar browser após 10 capturas
  browserIdleTimeout: 60_000, // fechar browser idle após 60s
  pageTimeout: 30_000,      // timeout máximo por captura
}
```

- Browsers são **reutilizados** entre capturas (warm pool, sem cold start)
- Cada captura abre um **novo page** (browser context), não um novo browser
- Browser é **reciclado** após N pages para evitar memory leaks do Chromium
- Container tem memory limit de 2GB com OOM-kill protection

### 10.3. Autoscaling (Queue-Based)

| Condição | Ação |
|----------|------|
| Queue depth > 10 por > 30s | Scale up workers |
| Queue depth = 0 por > 5 min | Scale down (mínimo 2 workers) |
| CPU > 80% por > 2 min | Scale up workers |

### 10.4. Throughput estimado

| Métrica | Valor |
|---------|-------|
| Tempo médio de captura (load + screenshot) | 8-12 segundos |
| Tempo de processamento de imagem | 1-2 segundos |
| Throughput por worker (pool de 3 browsers) | ~5 capturas/min |
| 4 workers | ~20 capturas/min |
| 8 workers (pico) | ~40 capturas/min |
| Backfill de 500 templates (4 workers) | ~25 minutos |

---

## 11. Observabilidade

### 11.1. Métricas (Prometheus)

| Métrica | Tipo | Labels |
|---------|------|--------|
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

### 11.2. Alertas

| Condição | Severidade | Ação |
|----------|-----------|------|
| Success rate < 90% (janela 15 min) | Warning | Investigar distribuição de error_codes |
| Success rate < 70% (janela 5 min) | Critical | Page on-call |
| Queue depth > 100 por > 5 min | Warning | Scale up workers |
| P95 capture time > 30s | Warning | Verificar sites alvo |
| Blank page rate > 20% | Warning | Revisar wait strategies |
| Worker OOM kills > 0 | Critical | Aumentar memória ou reduzir pool |

### 11.3. Logs estruturados

Todos os logs em formato JSON com campos padrão:

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
GET /healthz   → 200 (API está up)
GET /readyz    → 200 (API + DB + queue estão conectados)
GET /metrics   → Métricas em formato Prometheus
```

---

## 12. Retry e Failure Handling

### 12.1. Classificação de erros

| Error Code | Retryable | Max Retries | Backoff |
|-----------|-----------|-------------|---------|
| `timeout` | Sim | 3 | 10s → 30s → 60s |
| `dns_failure` | Sim | 2 | 30s → 120s |
| `connection_refused` | Sim | 2 | 60s → 300s |
| `blank_page` | Sim | 3 | 5s → 10s → 15s (com escalada de estratégia) |
| `http_5xx` | Sim | 2 | 30s → 120s |
| `browser_crash` | Sim | 2 | 5s → 10s |
| `ssl_error` | Não | 0 | — |
| `http_4xx` | Não | 0 | — |
| `blocked_by_firewall` | Não | 0 | — |
| `url_not_allowed` | Não | 0 | — |
| `internal_error` | Sim | 1 | 10s |

### 12.2. Fluxo de retry

```
1. Captura falha
2. Classifica erro → retryable?
   ├── Não: status=failed, armazena error_code/message, notifica callback
   └── Sim: attempts < max_attempts?
       ├── Não: status=failed, armazena erro, notifica callback
       └── Sim: Calcula next_retry_at (backoff exponencial)
               Para blank_page: escala wait strategy
               Re-enfileira com delay
```

### 12.3. Dead Letter Queue (DLQ)

Jobs que falham após todos os retries são movidos para uma DLQ para inspeção manual. Um dashboard permite:
- Ver jobs na DLQ agrupados por `error_code`
- Retry manual de jobs específicos
- Dismissal de jobs não recuperáveis

### 12.4. Stale Job Recovery

Um sweeper roda a cada 5 minutos e busca jobs com:
- `status = 'running'` há mais de 5 minutos (worker provavelmente crashou)
- Re-enfileira esses jobs com `attempts + 1`

---

## 13. Stack Recomendada

### 13.1. Tecnologias e justificativas

| Camada | Tecnologia | Justificativa |
|--------|-----------|---------------|
| **Linguagem** | TypeScript (Node.js 20+) | Mesma linguagem do Playwright; excelente para async I/O; type safety |
| **API Framework** | Fastify | Framework Node.js mais rápido; schema validation nativo; plugin ecosystem |
| **Headless Browser** | Playwright (Chromium) | Mais confiável que Puppeteer; waits nativos (networkidle, selector); API moderna; mantido pela Microsoft |
| **Image Processing** | Sharp (libvips) | Biblioteca mais rápida de processamento de imagem em Node.js; suporte nativo a WebP, AVIF, PNG |
| **Message Queue** | AWS SQS | Gerenciado, serverless, sem manutenção; suporte nativo a delay/visibility timeout; 2 filas (high/low priority) |
| **Database** | PostgreSQL 16 | JSONB para campos flexíveis (options); partial indexes; confiável e maduro |
| **ORM** | Drizzle ORM | Type-safe queries; leve (sem overhead de runtime); migrations nativas |
| **Object Storage** | SCS Edge Storage | Nativo da plataforma SCS; S3-compatible API; distribuição edge |
| **CDN** | SCS CDN | Nativo; Edge Functions para fallback (placeholder SVG); invalidação rápida |
| **Container Runtime** | Docker | Necessário para Playwright (precisa de Chromium + deps do sistema) |
| **Orchestration** | ECS ou Kubernetes | Autoscaling, health checks, resource limits |
| **Observability** | OpenTelemetry + Datadog/Grafana | Stack padrão de observabilidade; instrumentação automática para Node.js |
| **Validation** | Zod | Type-safe; declarativo; excelente para validar inputs da API |
| **Config** | dotenv + Zod | Variáveis de ambiente validadas com schema tipado |

### 13.2. Alternativa: Puppeteer vs Playwright

Escolhemos **Playwright** porque:
- `waitUntil: 'networkidle'` é built-in e mais confiável
- Auto-wait para selectors (sem `waitForSelector` explícito na maioria dos casos)
- Browser contexts são mais leves que instâncias separadas do Puppeteer
- Suporta múltiplos browsers (Chromium, Firefox, WebKit) se precisarmos no futuro
- Manutenção ativa pela Microsoft com releases regulares

---

## 14. Estrutura do Projeto

```
screenshot-capture-service/
│
├── src/
│   ├── api/
│   │   ├── routes/
│   │   │   ├── captures.ts           # POST /captures, GET /captures/:id
│   │   │   ├── entities.ts           # GET /entities/:type/:id/screenshots
│   │   │   ├── events.ts             # POST /events (webhook receiver)
│   │   │   └── health.ts             # /healthz, /readyz, /metrics
│   │   ├── middleware/
│   │   │   ├── auth.ts               # API key + webhook signature validation
│   │   │   ├── rate-limit.ts         # Rate limiting por key e global
│   │   │   └── error-handler.ts      # Error response formatting
│   │   └── server.ts                 # Fastify app setup
│   │
│   ├── worker/
│   │   ├── consumer.ts               # Queue consumer (SQS polling)
│   │   ├── capture-engine.ts         # Playwright orchestration
│   │   ├── browser-pool.ts           # Browser instance pool management
│   │   ├── blank-detector.ts         # Pixel variance analysis
│   │   └── wait-strategies.ts        # networkidle, selector, delay strategies
│   │
│   ├── processing/
│   │   ├── image-processor.ts        # Sharp resize/convert/optimize
│   │   └── storage-uploader.ts       # Edge Storage upload
│   │
│   ├── shared/
│   │   ├── db/
│   │   │   ├── schema.ts             # Drizzle ORM schema
│   │   │   ├── client.ts             # Database connection
│   │   │   └── migrations/           # SQL migrations
│   │   ├── queue/
│   │   │   ├── producer.ts           # Enqueue jobs
│   │   │   └── consumer.ts           # Dequeue jobs
│   │   ├── security/
│   │   │   ├── url-validator.ts      # SSRF prevention + allowlist
│   │   │   └── dns-resolver.ts       # IP validation (block private ranges)
│   │   ├── types/
│   │   │   ├── api.types.ts          # Request/response types
│   │   │   ├── job.types.ts          # Internal job types
│   │   │   └── events.types.ts       # Webhook event types
│   │   └── config.ts                 # Zod-validated environment config
│   │
│   ├── notifier/
│   │   └── webhook-notifier.ts       # POST results to callback URLs
│   │
│   └── scheduler/
│       ├── stale-job-sweeper.ts      # Recover stuck jobs
│       └── storage-gc.ts            # Clean old screenshot files
│
├── docker/
│   ├── Dockerfile                    # Multi-stage build with Playwright deps
│   └── docker-compose.yml            # Local dev (API + worker + postgres + localstack)
│
├── tests/
│   ├── unit/                         # Pure function tests
│   ├── integration/                  # API + DB tests
│   └── e2e/                          # Full pipeline tests
│
├── docs/
│   ├── api.md                        # API documentation
│   ├── architecture.md               # Architecture overview
│   └── runbook.md                    # Operations runbook
│
├── package.json
├── tsconfig.json
├── drizzle.config.ts
└── .env.example
```

---

## 15. Integração (Padrão de Consumo)

Qualquer cliente (dashboard, API interna, CI/CD pipeline) consome o SCS via REST API.

### 15.1. Fallback chain recomendada na UI

```
1. Screenshot disponível (WebP)       → mostrar preview image
2. Captura em andamento (status=running/queued) → skeleton + "Generating preview..."
3. Captura falhou / não existe        → imagem default do entity type
4. Nenhuma imagem disponível          → SVG placeholder genérico
```

### 15.2. Padrão de consumo

1. Consultar `GET /v1/entities/:entity_type/:entity_id/screenshots` para obter a URL da imagem
2. Se não existe screenshot: opcionalmente disparar `POST /v1/captures` e fazer polling
3. Se status `queued` ou `running`: poll `GET /v1/captures/:job_id` a cada 5s até `succeeded` ou `failed`
4. Imagens servidas via CDN — consumidor usa a `image_url` diretamente como `<img src>`

### 15.3. Exemplo de integração

```typescript
// Buscar screenshot de um template
const response = await fetch('/v1/entities/template/sol-12345/screenshots', {
  headers: { 'X-Api-Key': API_KEY }
})

const data = await response.json()

if (data.screenshots.length > 0) {
  // Tem screenshot → usar a URL da CDN
  const cardPreview = data.screenshots.find(s => s.viewport === 'card')
  imageElement.src = cardPreview.image_url
} else {
  // Sem screenshot → disparar captura
  await fetch('/v1/captures', {
    method: 'POST',
    headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: templateDemoUrl,
      entity_type: 'template',
      entity_id: 'sol-12345'
    })
  })
  // Mostrar skeleton enquanto captura
  imageElement.src = '/placeholders/generating-preview.svg'
}
```

---

## 16. Alternativas Consideradas

### 16.1. Serverless Functions (Lambda/Edge Functions) para captura

| Prós | Contras |
|------|---------|
| Zero infra para gerenciar | Chromium (~400MB) não cabe em Edge Functions (V8 isolates) |
| Scale to zero | Cold start de 10-15s para carregar browser |
| Pay-per-use | Timeout máximo de 30-60s (apertado para captura + processamento) |
| | Sem reuso de browser entre invocações (cada call = cold start) |

**Decisão:** Descartado. Headless browsers precisam de containers dedicados com memória suficiente e beneficiam enormemente de pool quente.

### 16.2. Serviço de terceiros (Screenshotlayer, URLBox, etc.)

| Prós | Contras |
|------|---------|
| Zero desenvolvimento | Dependência externa |
| Pronto para uso | Custo por screenshot ($0.01-0.05 cada) |
| | Sem controle sobre qualidade/timing |
| | Dados (URLs) saem da infra SCS |
| | Latência adicional |

**Decisão:** Descartado. Volume alto, necessidade de controle fino sobre qualidade, e URLs internas precisam ficar na infra SCS.

### 16.3. Captura no client-side (browser do usuário)

| Prós | Contras |
|------|---------|
| Zero infra backend | Depende do usuário abrir o dashboard |
| | Qualidade inconsistente |
| | Não funciona para automação |
| | Problemas de CORS com URLs de templates |

**Decisão:** Descartado. Não atende o requisito de automação e consistência.

### 16.4. Puppeteer em vez de Playwright

| Prós | Contras |
|------|---------|
| Comunidade maior | Apenas Chrome |
| Mais leve | Waits manuais (sem networkidle nativo confiável) |
| | Browser contexts menos isolados |
| | Menos manutenção ativa |

**Decisão:** Playwright é preferido por estabilidade, waits nativos, e melhor gerenciamento de contextos.

### 16.5. Redis/BullMQ em vez de SQS

| Prós | Contras |
|------|---------|
| Mais controle (priority, delay, rate limiting) | Infra adicional para gerenciar (Redis) |
| Dashboard built-in (Bull Board) | Não é serverless |
| Melhor para jobs complexos | Mais um ponto de falha |

**Decisão:** SQS para o MVP e v1.0 por simplicidade. BullMQ pode ser considerado se precisarmos de funcionalidades avançadas de queue (priority granular, jobs dependentes).

---

## 17. Rollout em Fases

### MVP

| Item | Descrição |
|------|-----------|
| **Escopo** | API + worker inline (mesmo processo), template only, card viewport, SQLite, 1 container |
| **Entregáveis** | `POST/GET /v1/captures`, `GET /v1/screenshots`, deploy via Docker em EC2/ECS |
| **Validação** | Capturar screenshots de 10 templates reais, verificar qualidade visual |
| **Critérios de sucesso** | >80% das capturas sem blank page; imagens servidas via CDN em <500ms |

### v1.0

| Item | Descrição |
|------|-----------|
| **Escopo** | PostgreSQL, SQS, worker separado com browser pool, webhook receiver, bulk endpoint |
| **Entregáveis** | Backfill de todos os templates existentes; integração com CI/CD de templates |
| **Validação** | Backfill completo de 500+ templates; zero downtime durante deploy |
| **Critérios de sucesso** | >90% success rate; P95 < 15s por captura |

### v1.1

| Item | Descrição |
|------|-----------|
| **Escopo** | Entity types application + deployment; viewports detail e OG; callback notifications |
| **Entregáveis** | Integração com pipeline de deploy; previews em 3 tamanhos |
| **Validação** | Preview gerado automaticamente em <30s após deploy finish |

### v2.0

| Item | Descrição |
|------|-----------|
| **Escopo** | Autoscaling, métricas Prometheus completas, DLQ dashboard, recaptura agendada (cron) |
| **Entregáveis** | Dashboard de observabilidade; alertas configurados; GC automatizado |

---

## 18. Riscos e Mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|-------|--------------|---------|-----------|
| Alta taxa de blank pages | Média | Alto | Escalada de wait strategies; análise de pixel variance; retry com estratégias diferentes |
| Memory leaks do Chromium | Alta | Médio | Reciclagem de browser após N capturas; memory limits no container; monitoring de RSS |
| SSRF via URLs maliciosas | Baixa | Crítico | Allowlist rigorosa; DNS rebinding protection; sandbox do browser |
| Custo de infra (containers pesados) | Média | Médio | Autoscaling agressivo para baixo; scale to 2 workers em idle |
| URLs de templates ficam offline | Média | Baixo | Retry com backoff; manter último screenshot válido (is_latest não muda se falha) |
| Chromium updates quebram capturas | Baixa | Alto | Pin version do Playwright; testes e2e antes de upgrade; rollback rápido |

---

## 19. Decisões em Aberto

| # | Decisão | Opções | Responsável |
|---|---------|--------|-------------|
| 1 | Domínio do CDN de screenshots | `screenshots.example.com` vs subpath de CDN existente | Infra |
| 2 | Allowlist inicial de URLs | Apenas `*.example.app` ou incluir domínios custom dos clientes? | Product |
| 3 | SQS vs BullMQ para queue | Simplicidade (SQS) vs controle (BullMQ) | Engineering |
| 4 | SVG placeholder de fallback | Usar design genérico ou criar por entity_type? | Design |
| 5 | Frequência de recaptura automática | Apenas on-publish ou cron periódico (semanal)? | Product |
| 6 | Suporte a domínios custom de clientes | Fase v1.1 ou v2.0? Implicações de SSRF | Security + Product |
| 7 | Orquestração: ECS vs Kubernetes | Depende da infra atual da SCS | Infra/DevOps |
