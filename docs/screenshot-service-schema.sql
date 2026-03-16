-- ============================================================================
-- Screenshot Capture Service (SCS) — Database Schema
-- PostgreSQL 16+
-- ============================================================================
--
-- Este schema define as tabelas, índices e constraints do serviço de captura
-- de screenshots da SCS.
--
-- Tabelas:
--   1. capture_jobs    — Estado e metadados de cada job de captura
--   2. screenshots     — Imagens geradas (resultados de cada captura)
--   3. url_allowlist   — Padrões de URL permitidos (prevenção de SSRF)
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Extensions
-- ----------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- para gen_random_uuid()


-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------

-- Status do job de captura
CREATE TYPE capture_status AS ENUM (
    'queued',              -- Na fila, aguardando worker
    'running',             -- Worker executando captura
    'processing_images',   -- Captura ok, processando/otimizando imagens
    'succeeded',           -- Imagens prontas e disponíveis via CDN
    'failed',              -- Falha após todos os retries
    'cancelled'            -- Cancelado manualmente
);

-- Tipo de entidade
CREATE TYPE entity_type AS ENUM (
    'template',            -- Template do marketplace
    'application',         -- Edge application de cliente
    'deployment'           -- Deploy específico de uma application
);

-- Viewport preset
CREATE TYPE viewport_type AS ENUM (
    'card',                -- 1366x768 — preview (tela de notebook)
    'detail',              -- 1280x800 — página de detalhe
    'og'                   -- 1200x630 — Open Graph / social sharing
);

-- Formato de imagem
CREATE TYPE image_format AS ENUM (
    'webp',
    'png',
    'avif'
);

-- Código de erro
CREATE TYPE error_code AS ENUM (
    'timeout',             -- Timeout durante navegação ou captura
    'dns_failure',         -- Falha de resolução DNS
    'connection_refused',  -- Conexão recusada pelo servidor
    'blank_page',          -- Screenshot detectado como tela em branco
    'ssl_error',           -- Erro de certificado SSL
    'http_4xx',            -- Resposta HTTP 4xx do site alvo
    'http_5xx',            -- Resposta HTTP 5xx do site alvo
    'browser_crash',       -- Browser crashou durante captura
    'blocked_by_firewall', -- Bloqueado por firewall/WAF do site alvo
    'url_not_allowed',     -- URL fora da allowlist
    'internal_error'       -- Erro interno do serviço
);

-- Prioridade da fila
CREATE TYPE queue_priority AS ENUM (
    'high',
    'low'
);


-- ----------------------------------------------------------------------------
-- Tabela: capture_jobs
-- Armazena o estado e metadados de cada job de captura.
-- ----------------------------------------------------------------------------

CREATE TABLE capture_jobs (
    -- Identificação
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Dados da captura
    url             TEXT NOT NULL,                    -- URL alvo (deve ser HTTPS + allowlist)
    entity_type     entity_type NOT NULL,             -- Tipo da entidade
    entity_id       VARCHAR(255) NOT NULL,            -- ID da entidade no sistema de origem

    -- Estado do job
    status          capture_status NOT NULL DEFAULT 'queued',
    priority        SMALLINT NOT NULL DEFAULT 5       -- 1 (highest) a 10 (lowest)
        CHECK (priority BETWEEN 1 AND 10),

    -- Controle de retries
    attempts        SMALLINT NOT NULL DEFAULT 0       -- Tentativas realizadas
        CHECK (attempts >= 0),
    max_attempts    SMALLINT NOT NULL DEFAULT 3       -- Máximo de tentativas
        CHECK (max_attempts >= 1 AND max_attempts <= 10),

    -- Configurações
    options         JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Exemplo de options:
    -- {
    --   "viewports": ["card", "detail"],
    --   "wait_strategy": "networkidle",
    --   "wait_selector": "#app",
    --   "wait_timeout_ms": 15000,
    --   "delay_after_load_ms": 2000
    -- }

    -- Callback
    callback_url    TEXT,                             -- URL para POST pós-captura (opcional)

    -- Lote (bulk)
    batch_id        UUID,                             -- ID do lote se bulk request

    -- Erro
    error_message   TEXT,                             -- Mensagem descritiva do erro
    error_code_val  error_code,                       -- Código classificado do erro

    -- Worker
    worker_id       VARCHAR(100),                     -- Identificador do worker que processou

    -- Timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,                      -- Quando o worker iniciou
    completed_at    TIMESTAMPTZ,                      -- Quando finalizou (sucesso ou falha)
    next_retry_at   TIMESTAMPTZ                       -- Próxima tentativa programada
);

-- Comentários
COMMENT ON TABLE capture_jobs IS 'Jobs de captura de screenshot. Cada job representa uma requisição para capturar uma URL.';
COMMENT ON COLUMN capture_jobs.url IS 'URL alvo para captura. Deve ser HTTPS e corresponder a um padrão da url_allowlist.';
COMMENT ON COLUMN capture_jobs.options IS 'Configurações da captura em JSONB: viewports, wait_strategy, wait_selector, timeouts.';
COMMENT ON COLUMN capture_jobs.priority IS 'Prioridade na fila: 1 = máxima, 10 = mínima. Default: 5.';
COMMENT ON COLUMN capture_jobs.batch_id IS 'Identificador do lote quando o job foi criado via POST /captures/bulk.';
COMMENT ON COLUMN capture_jobs.error_code_val IS 'Código classificado do erro para agrupamento e métricas.';
COMMENT ON COLUMN capture_jobs.next_retry_at IS 'Timestamp para próxima tentativa. NULL se não há retry programado.';


-- ========================
-- Índices: capture_jobs
-- ========================

-- Busca eficiente do próximo job na fila (worker polling)
-- Filtra apenas queued, ordena por prioridade e criação
CREATE INDEX idx_jobs_queue_poll
    ON capture_jobs (priority ASC, created_at ASC)
    WHERE status = 'queued';

-- Busca por entidade (deduplicação, consulta de histórico)
CREATE INDEX idx_jobs_entity
    ON capture_jobs (entity_type, entity_id);

-- Busca por lote
CREATE INDEX idx_jobs_batch
    ON capture_jobs (batch_id)
    WHERE batch_id IS NOT NULL;

-- Jobs de retry pendentes
CREATE INDEX idx_jobs_retry
    ON capture_jobs (next_retry_at ASC)
    WHERE status = 'queued' AND attempts > 0;

-- Stale job detection (jobs running por muito tempo = worker crashou)
CREATE INDEX idx_jobs_stale
    ON capture_jobs (started_at)
    WHERE status = 'running';

-- Deduplicação: busca rápida de jobs ativos para mesma entidade
CREATE INDEX idx_jobs_active_entity
    ON capture_jobs (entity_type, entity_id)
    WHERE status IN ('queued', 'running');


-- ----------------------------------------------------------------------------
-- Tabela: screenshots
-- Armazena os resultados (imagens geradas) de cada captura.
-- Uma captura pode gerar múltiplos screenshots (um por viewport/formato).
-- ----------------------------------------------------------------------------

CREATE TABLE screenshots (
    -- Identificação
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Referência ao job
    job_id          UUID NOT NULL REFERENCES capture_jobs(id) ON DELETE CASCADE,

    -- Entidade (denormalizado para query rápida sem JOIN)
    entity_type     entity_type NOT NULL,
    entity_id       VARCHAR(255) NOT NULL,

    -- Detalhes da imagem
    viewport        viewport_type NOT NULL,           -- card, detail, og
    width           INT NOT NULL                      -- Largura em pixels
        CHECK (width > 0 AND width <= 3840),
    height          INT NOT NULL                      -- Altura em pixels
        CHECK (height > 0 AND height <= 2160),
    format          image_format NOT NULL,            -- webp, png, avif

    -- Storage
    storage_key     TEXT NOT NULL,                    -- Chave no Edge Storage
    -- Exemplo: screenshots/template/sol-12345/card-400x300-v1710583212.webp
    cdn_url         TEXT NOT NULL,                    -- URL pública via CDN
    -- Exemplo: https://screenshots.example.com/template/sol-12345/card-400x300-v1710583212.webp
    file_size_bytes INT                               -- Tamanho do arquivo
        CHECK (file_size_bytes IS NULL OR file_size_bytes > 0),

    -- Versionamento
    is_latest       BOOLEAN NOT NULL DEFAULT TRUE,    -- Apenas o mais recente = true

    -- Timestamp
    captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Comentários
COMMENT ON TABLE screenshots IS 'Imagens de screenshot geradas. Cada job pode gerar múltiplos screenshots (viewports × formatos).';
COMMENT ON COLUMN screenshots.entity_type IS 'Denormalizado de capture_jobs para permitir queries sem JOIN.';
COMMENT ON COLUMN screenshots.is_latest IS 'TRUE para o screenshot mais recente de cada entity+viewport+format. Apenas um por combinação.';
COMMENT ON COLUMN screenshots.storage_key IS 'Chave completa do arquivo no SCS Edge Storage.';
COMMENT ON COLUMN screenshots.cdn_url IS 'URL pública servida via SCS CDN. Cache imutável (nova captura = nova key).';


-- ========================
-- Índices: screenshots
-- ========================

-- Query principal: buscar screenshots mais recentes de uma entidade
-- Usado por GET /v1/entities/:type/:id/screenshots
CREATE INDEX idx_screenshots_entity_latest
    ON screenshots (entity_type, entity_id)
    WHERE is_latest = TRUE;

-- Constraint: apenas 1 screenshot "latest" por combinação entity+viewport+format
-- Garante integridade dos dados ao atualizar is_latest
CREATE UNIQUE INDEX idx_screenshots_unique_latest
    ON screenshots (entity_type, entity_id, viewport, format)
    WHERE is_latest = TRUE;

-- Garbage collection: encontrar screenshots antigos para limpeza
CREATE INDEX idx_screenshots_gc
    ON screenshots (captured_at)
    WHERE is_latest = FALSE;

-- Busca por job (para listar resultados de um job específico)
CREATE INDEX idx_screenshots_job
    ON screenshots (job_id);


-- ----------------------------------------------------------------------------
-- Tabela: url_allowlist
-- Padrões de URL permitidos para captura (prevenção de SSRF).
-- Apenas URLs que correspondem a um padrão ativo são aceitas.
-- ----------------------------------------------------------------------------

CREATE TABLE url_allowlist (
    id          SERIAL PRIMARY KEY,
    pattern     TEXT NOT NULL,                        -- Regex pattern (ex: ^[\w-]+\.example\.app$)
    description TEXT,                                 -- Descrição do padrão
    active      BOOLEAN NOT NULL DEFAULT TRUE,        -- Se o padrão está ativo
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Comentários
COMMENT ON TABLE url_allowlist IS 'Padrões de URL permitidos para captura. Prevenção de SSRF.';
COMMENT ON COLUMN url_allowlist.pattern IS 'Expressão regular para validar o hostname da URL. Ex: ^[\\w-]+\\.example\\.app$';

-- Índice para buscar padrões ativos
CREATE INDEX idx_allowlist_active
    ON url_allowlist (active)
    WHERE active = TRUE;


-- ----------------------------------------------------------------------------
-- Dados iniciais: url_allowlist
-- Padrões padrão para o ambiente SCS
-- ----------------------------------------------------------------------------

INSERT INTO url_allowlist (pattern, description) VALUES
    ('^[\w-]+\.example\.app$', 'SCS edge applications (*.example.app)'),
    ('^[\w-]+\.exampleedge\.net$', 'SCS edge network (*.exampleedge.net)'),
    ('^[\w-]+\.exampleedge\.com$', 'SCS edge network (*.exampleedge.com)');


-- ============================================================================
-- Functions
-- ============================================================================

-- Function: Atualizar is_latest ao inserir novo screenshot
-- Marca o anterior como is_latest=false antes de inserir o novo
CREATE OR REPLACE FUNCTION update_latest_screenshot()
RETURNS TRIGGER AS $$
BEGIN
    -- Se o novo screenshot é marcado como latest, desmarcar os anteriores
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

COMMENT ON FUNCTION update_latest_screenshot IS 'Garante que apenas 1 screenshot é marcado como is_latest para cada combinação entity+viewport+format.';


-- Function: Atualizar updated_at na url_allowlist
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
-- Views (para consultas comuns)
-- ============================================================================

-- View: Screenshots mais recentes por entidade
-- Simplifica a query do endpoint GET /v1/entities/:type/:id/screenshots
CREATE VIEW latest_screenshots AS
SELECT
    s.entity_type,
    s.entity_id,
    s.viewport,
    s.width,
    s.height,
    s.format,
    s.cdn_url AS image_url,
    s.file_size_bytes,
    s.captured_at,
    j.url AS source_url
FROM screenshots s
JOIN capture_jobs j ON s.job_id = j.id
WHERE s.is_latest = TRUE;

COMMENT ON VIEW latest_screenshots IS 'Screenshots mais recentes por entidade. Usado pelo endpoint GET /v1/entities/:type/:id/screenshots.';


-- View: Jobs com status ativo (para monitoramento)
CREATE VIEW active_jobs AS
SELECT
    id,
    url,
    entity_type,
    entity_id,
    status,
    priority,
    attempts,
    worker_id,
    created_at,
    started_at,
    EXTRACT(EPOCH FROM (NOW() - started_at)) AS running_seconds
FROM capture_jobs
WHERE status IN ('queued', 'running', 'processing_images')
ORDER BY priority ASC, created_at ASC;

COMMENT ON VIEW active_jobs IS 'Jobs ativos (queued, running, processing). Útil para monitoramento e debugging.';


-- View: Métricas agregadas por entity_type
CREATE VIEW capture_metrics AS
SELECT
    entity_type,
    status,
    COUNT(*) AS total_jobs,
    AVG(EXTRACT(EPOCH FROM (completed_at - started_at)))::NUMERIC(10,2) AS avg_duration_seconds,
    MAX(EXTRACT(EPOCH FROM (completed_at - started_at)))::NUMERIC(10,2) AS max_duration_seconds,
    COUNT(*) FILTER (WHERE error_code_val = 'blank_page') AS blank_page_count,
    COUNT(*) FILTER (WHERE error_code_val = 'timeout') AS timeout_count
FROM capture_jobs
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY entity_type, status
ORDER BY entity_type, status;

COMMENT ON VIEW capture_metrics IS 'Métricas agregadas das últimas 24h por entity_type e status.';


-- ============================================================================
-- Notas de operação
-- ============================================================================
--
-- GARBAGE COLLECTION (rodar diariamente):
--   1. Buscar screenshots antigos:
--      SELECT storage_key FROM screenshots
--      WHERE is_latest = FALSE AND captured_at < NOW() - INTERVAL '7 days';
--
--   2. Deletar arquivos do Edge Storage (via API)
--
--   3. Remover registros do banco:
--      DELETE FROM screenshots
--      WHERE is_latest = FALSE AND captured_at < NOW() - INTERVAL '7 days';
--
-- STALE JOB RECOVERY (rodar a cada 5 minutos):
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
-- DEAD LETTER (jobs que falharam definitivamente):
--   SELECT * FROM capture_jobs
--   WHERE status = 'failed'
--   ORDER BY completed_at DESC;
--
-- ============================================================================
