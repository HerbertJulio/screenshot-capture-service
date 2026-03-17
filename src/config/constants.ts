// -- Capture Engine --

export const BLANK_PAGE_STDDEV_THRESHOLD = 5
export const VIEWPORT_SETTLE_MS = 300
export const BLANK_PAGE_RETRY_DELAY_MS = 3000
export const WEBP_QUALITY = 80
export const NETWORKIDLE_TIMEOUT_MS = 5_000
export const SCROLL_SETTLE_MS = 500

// -- Callback --

export const CALLBACK_TIMEOUT_MS = 10_000

// -- Job Priorities --

export const PRIORITY_HIGH = 3
export const PRIORITY_LOW = 8
export const PRIORITY_DEFAULT = 5

// -- API Limits --

export const BODY_LIMIT_BYTES = 1_048_576
export const RATE_LIMIT_MAX = 60
export const RATE_LIMIT_WINDOW_MS = 60_000
export const RATE_LIMIT_PRUNE_INTERVAL_MS = 5 * 60_000

// -- Worker --

export const DEFAULT_POLL_MS = 1_000
export const STALE_JOB_RECOVERY_INTERVAL_MS = 5 * 60_000
export const STALE_JOB_TIMEOUT_MINUTES = 5

// -- Retry Delays (ms) by Error Code --

export const RETRY_DELAYS: Record<string, number[]> = {
  timeout: [10_000, 30_000, 60_000],
  dns_failure: [30_000, 120_000],
  blank_page: [5_000, 10_000, 15_000],
  http_5xx: [30_000, 120_000],
  browser_crash: [5_000, 10_000],
  connection_refused: [60_000, 300_000],
  internal_error: [10_000],
}

export const NON_RETRYABLE_ERRORS = [
  'ssl_error',
  'http_4xx',
  'blocked_by_firewall',
  'url_not_allowed',
] as const

// -- Default Capture Options --

export const DEFAULT_CAPTURE_OPTIONS = {
  viewports: ['card'] as const,
  waitStrategy: 'networkidle' as const,
  waitSelector: null,
  waitTimeoutMs: 15_000,
  delayAfterLoadMs: 2_000,
}
