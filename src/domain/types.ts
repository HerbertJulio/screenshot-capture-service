import { z } from 'zod'

// -- Entity --

export const ENTITY_TYPES = ['template', 'application', 'deployment'] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

export function isValidEntityType(value: string): value is EntityType {
  return ENTITY_TYPES.includes(value as EntityType)
}

// -- Job --

export type JobStatus =
  | 'queued'
  | 'running'
  | 'processing_images'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type ErrorCode =
  | 'timeout'
  | 'dns_failure'
  | 'connection_refused'
  | 'blank_page'
  | 'ssl_error'
  | 'http_4xx'
  | 'http_5xx'
  | 'browser_crash'
  | 'blocked_by_firewall'
  | 'url_not_allowed'
  | 'internal_error'

// -- Viewport & Image --

export const VIEWPORT_PRESETS = {
  card: { width: 1366, height: 768 },
  detail: { width: 1280, height: 800 },
} as const

export type ViewportName = keyof typeof VIEWPORT_PRESETS
export type ImageFormat = 'webp' | 'png'

// -- Interfaces --

export interface CaptureOptions {
  viewports: ViewportName[]
  waitStrategy: 'networkidle' | 'domcontentloaded' | 'load'
  waitSelector: string | null
  waitTimeoutMs: number
  delayAfterLoadMs: number
}

export interface CaptureJob {
  id: string
  url: string
  entityType: EntityType
  entityId: string
  status: JobStatus
  priority: number
  attempts: number
  maxAttempts: number
  options: CaptureOptions
  callbackUrl: string | null
  batchId: string | null
  errorMessage: string | null
  errorCode: ErrorCode | null
  workerId: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  nextRetryAt: string | null
}

export interface ScreenshotRecord {
  id: string
  jobId: string
  entityType: EntityType
  entityId: string
  viewport: ViewportName
  width: number
  height: number
  format: ImageFormat
  storageKey: string
  cdnUrl: string
  fileSizeBytes: number | null
  isLatest: boolean
  capturedAt: string
}

export interface CaptureResult {
  viewport: ViewportName
  width: number
  height: number
  format: ImageFormat
  buffer: Buffer
  fileSizeBytes: number
}

// -- Zod Schemas (API validation) --

export const createCaptureSchema = z.object({
  url: z.string().url(),
  entity_type: z.enum(ENTITY_TYPES),
  entity_id: z.string().min(1).max(255),
  callback_url: z.string().url().optional(),
  options: z
    .object({
      viewports: z
        .array(z.enum(['card', 'detail'] as const))
        .default(['card']),
      wait_strategy: z
        .enum(['networkidle', 'domcontentloaded', 'load'])
        .default('networkidle'),
      wait_selector: z.string().optional(),
      wait_timeout_ms: z.number().min(1000).max(60000).default(15000),
      delay_after_load_ms: z.number().min(0).max(10000).default(2000),
    })
    .default({}),
})

export type CreateCaptureInput = z.infer<typeof createCaptureSchema>

export const bulkCaptureSchema = z.object({
  items: z
    .array(
      z.object({
        url: z.string().url(),
        entity_type: z.enum(ENTITY_TYPES),
        entity_id: z.string().min(1).max(255),
      })
    )
    .min(1)
    .max(100),
  priority: z.enum(['high', 'low']).default('high'),
})

export type BulkCaptureInput = z.infer<typeof bulkCaptureSchema>

export const webhookEventSchema = z.object({
  event_type: z.enum([
    'template.published',
    'template.updated',
    'deployment.finished',
    'manual.trigger',
  ]),
  entity_type: z.enum(ENTITY_TYPES),
  entity_id: z.string().min(1),
  url: z.string().url(),
  timestamp: z.string().optional(),
})

export type WebhookEventInput = z.infer<typeof webhookEventSchema>
