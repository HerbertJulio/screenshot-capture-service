import pino from 'pino'
import {
  claimNextJob,
  updateJobStatus,
  insertScreenshot,
  getScreenshotsByJobId,
} from '../shared/db/database.js'
import { captureScreenshots } from './capture-engine.js'
import { uploadScreenshot, buildStorageKey, buildCdnUrl } from '../processing/storage-uploader.js'
import { getConfig } from '../shared/config.js'
import type { CaptureJob, ErrorCode } from '../shared/types/job.types.js'

const logger = pino({ name: 'job-processor' })

const RETRY_DELAYS: Record<string, number[]> = {
  timeout: [10_000, 30_000, 60_000],
  dns_failure: [30_000, 120_000],
  blank_page: [5_000, 10_000, 15_000],
  http_5xx: [30_000, 120_000],
  browser_crash: [5_000, 10_000],
  connection_refused: [60_000, 300_000],
  internal_error: [10_000],
}

const NON_RETRYABLE: ErrorCode[] = [
  'ssl_error',
  'http_4xx',
  'blocked_by_firewall',
  'url_not_allowed',
]

function classifyError(error: unknown): { code: ErrorCode; message: string } {
  const msg = error instanceof Error ? error.message : String(error)
  const lower = msg.toLowerCase()

  if (lower.includes('timeout') || lower.includes('navigation timeout'))
    return { code: 'timeout', message: msg }
  if (lower.includes('dns') || lower.includes('getaddrinfo'))
    return { code: 'dns_failure', message: msg }
  if (lower.includes('econnrefused'))
    return { code: 'connection_refused', message: msg }
  if (lower.includes('ssl') || lower.includes('cert'))
    return { code: 'ssl_error', message: msg }
  if (lower.includes('net::err_blocked'))
    return { code: 'blocked_by_firewall', message: msg }
  if (lower.includes('browser') && lower.includes('crash'))
    return { code: 'browser_crash', message: msg }
  if (lower.includes('404') || lower.includes('403'))
    return { code: 'http_4xx', message: msg }
  if (lower.includes('5') && lower.includes('00'))
    return { code: 'http_5xx', message: msg }

  return { code: 'internal_error', message: msg }
}

function getRetryDelay(code: ErrorCode, attempt: number): number | null {
  if (NON_RETRYABLE.includes(code)) return null
  const delays = RETRY_DELAYS[code] ?? [10_000]
  return delays[Math.min(attempt - 1, delays.length - 1)] ?? null
}

async function processJob(job: CaptureJob): Promise<void> {
  const startTime = Date.now()
  logger.info({ jobId: job.id, url: job.url, attempt: job.attempts }, 'Processing job')

  try {
    // Capture
    const results = await captureScreenshots(job.url, job.options.viewports, {
      waitTimeoutMs: job.options.waitTimeoutMs,
      delayAfterLoadMs: job.options.delayAfterLoadMs,
      waitSelector: job.options.waitSelector,
    })

    if (results.length === 0) {
      throw new Error('No screenshots captured')
    }

    // Update status
    updateJobStatus(job.id, 'processing_images')

    // Upload each result
    for (const result of results) {
      const storageKey = buildStorageKey(
        job.entityType,
        job.entityId,
        result.viewport,
        result.width,
        result.height,
        result.format
      )
      const cdnUrl = buildCdnUrl(storageKey)

      await uploadScreenshot(storageKey, result.buffer, result.format)

      insertScreenshot({
        jobId: job.id,
        entityType: job.entityType,
        entityId: job.entityId,
        viewport: result.viewport,
        width: result.width,
        height: result.height,
        format: result.format,
        storageKey,
        cdnUrl,
        fileSizeBytes: result.fileSizeBytes,
      })
    }

    updateJobStatus(job.id, 'succeeded')

    const durationMs = Date.now() - startTime
    const screenshots = getScreenshotsByJobId(job.id)
    logger.info(
      {
        jobId: job.id,
        url: job.url,
        durationMs,
        screenshots: screenshots.length,
        attempt: job.attempts,
      },
      'Job succeeded'
    )

    // Callback
    if (job.callbackUrl) {
      notifyCallback(job, screenshots).catch((err) =>
        logger.error({ err, jobId: job.id }, 'Callback failed')
      )
    }
  } catch (error) {
    const { code, message } = classifyError(error)
    const retryDelay = getRetryDelay(code, job.attempts)
    const canRetry = retryDelay !== null && job.attempts < job.maxAttempts

    if (canRetry) {
      const nextRetryAt = new Date(Date.now() + retryDelay!).toISOString()
      updateJobStatus(job.id, 'queued', { errorCode: code, errorMessage: message, nextRetryAt })
      logger.warn(
        { jobId: job.id, errorCode: code, attempt: job.attempts, nextRetryAt },
        'Job will retry'
      )
    } else {
      updateJobStatus(job.id, 'failed', { errorCode: code, errorMessage: message })
      const durationMs = Date.now() - startTime
      logger.error(
        { jobId: job.id, errorCode: code, message, durationMs, attempt: job.attempts },
        'Job failed permanently'
      )

      if (job.callbackUrl) {
        notifyCallback(job, [], code, message).catch((err) =>
          logger.error({ err, jobId: job.id }, 'Failure callback failed')
        )
      }
    }
  }
}

async function notifyCallback(
  job: CaptureJob,
  screenshots: Array<{ viewport: string; cdnUrl: string; width: number; height: number; format: string }>,
  errorCode?: string,
  errorMessage?: string
): Promise<void> {
  if (!job.callbackUrl) return

  const payload = {
    event: errorCode ? 'capture.failed' : 'capture.completed',
    job_id: job.id,
    status: errorCode ? 'failed' : 'succeeded',
    entity_type: job.entityType,
    entity_id: job.entityId,
    error: errorCode ? { code: errorCode, message: errorMessage } : undefined,
    screenshots: screenshots.map((s) => ({
      viewport: s.viewport,
      image_url: s.cdnUrl,
      width: s.width,
      height: s.height,
      format: s.format,
    })),
  }

  const response = await fetch(job.callbackUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    logger.warn({ status: response.status, jobId: job.id }, 'Callback returned non-2xx')
  }
}

// -- Worker Loop --

let running = false
let pollInterval: ReturnType<typeof setInterval> | null = null
let staleInterval: ReturnType<typeof setInterval> | null = null
let activeJobs = 0

const WORKER_ID = `worker-${process.pid}-${Date.now()}`

export function startWorker(pollMs: number = 1000): void {
  if (running) return
  running = true

  const config = getConfig()
  const maxConcurrent = config.MAX_CONCURRENT_CAPTURES
  logger.info({ workerId: WORKER_ID, pollMs, maxConcurrent }, 'Worker started')

  pollInterval = setInterval(async () => {
    if (!running || activeJobs >= maxConcurrent) return

    try {
      const job = claimNextJob(WORKER_ID)
      if (job) {
        activeJobs++
        processJob(job)
          .catch((err) => logger.error({ err, jobId: job.id }, 'Job processing error'))
          .finally(() => { activeJobs-- })
      }
    } catch (err) {
      logger.error({ err }, 'Worker poll error')
    }
  }, pollMs)

  // Stale job recovery every 5 minutes
  staleInterval = setInterval(() => {
    try {
      const recovered = recoverStaleJobs()
      if (recovered > 0) {
        logger.info({ recovered }, 'Recovered stale jobs')
      }
    } catch (err) {
      logger.error({ err }, 'Stale recovery error')
    }
  }, 5 * 60_000)
}

export function stopWorker(): void {
  running = false
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
  if (staleInterval) {
    clearInterval(staleInterval)
    staleInterval = null
  }
  logger.info({ activeJobs }, 'Worker stopped')
}

// Re-export for stale recovery
import { recoverStaleJobs } from '../shared/db/database.js'
