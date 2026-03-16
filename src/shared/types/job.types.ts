export type EntityType = 'template' | 'application' | 'deployment'

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

export type ViewportName = 'card' | 'detail'
export type ImageFormat = 'webp' | 'png'

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

export interface CaptureOptions {
  viewports: ViewportName[]
  waitStrategy: 'networkidle' | 'domcontentloaded' | 'load'
  waitSelector: string | null
  waitTimeoutMs: number
  delayAfterLoadMs: number
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
