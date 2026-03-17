import pino from 'pino'
import { captureScreenshots } from './capture-engine.js'
import { classifyError, getRetryDelay } from '../domain/errors.js'
import { buildStorageKey } from '../infra/storage/storage.js'
import type { IJobRepository } from '../domain/ports/job-repository.port.js'
import type { IScreenshotRepository } from '../domain/ports/screenshot-repository.port.js'
import type { IStorageProvider } from '../domain/ports/storage.port.js'
import type { BrowserPool } from './browser-pool.js'
import type { CallbackNotifier } from './callback-notifier.js'
import type { CaptureJob } from '../domain/types.js'
import {
  DEFAULT_POLL_MS,
  STALE_JOB_RECOVERY_INTERVAL_MS,
} from '../config/constants.js'

const logger = pino({ name: 'job-processor' })

export interface JobProcessorDeps {
  jobRepo: IJobRepository
  screenshotRepo: IScreenshotRepository
  storage: IStorageProvider
  browserPool: BrowserPool
  callbackNotifier: CallbackNotifier
  maxConcurrent: number
}

export class JobProcessor {
  private running = false
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private staleInterval: ReturnType<typeof setInterval> | null = null
  private activeJobs = 0
  private readonly workerId = `worker-${process.pid}-${Date.now()}`

  constructor(private readonly deps: JobProcessorDeps) {}

  start(pollMs: number = DEFAULT_POLL_MS): void {
    if (this.running) return
    this.running = true

    logger.info({ workerId: this.workerId, pollMs, maxConcurrent: this.deps.maxConcurrent }, 'Worker started')

    this.pollInterval = setInterval(async () => {
      if (!this.running || this.activeJobs >= this.deps.maxConcurrent) return

      try {
        const job = this.deps.jobRepo.claimNextJob(this.workerId)
        if (job) {
          this.activeJobs++
          this.processJob(job)
            .catch((err) => logger.error({ err, jobId: job.id }, 'Job processing error'))
            .finally(() => { this.activeJobs-- })
        }
      } catch (err) {
        logger.error({ err }, 'Worker poll error')
      }
    }, pollMs)

    this.staleInterval = setInterval(() => {
      try {
        const recovered = this.deps.jobRepo.recoverStaleJobs()
        if (recovered > 0) {
          logger.info({ recovered }, 'Recovered stale jobs')
        }
      } catch (err) {
        logger.error({ err }, 'Stale recovery error')
      }
    }, STALE_JOB_RECOVERY_INTERVAL_MS)
  }

  stop(): void {
    this.running = false
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
    if (this.staleInterval) {
      clearInterval(this.staleInterval)
      this.staleInterval = null
    }
    logger.info({ activeJobs: this.activeJobs }, 'Worker stopped')
  }

  private async processJob(job: CaptureJob): Promise<void> {
    const startTime = Date.now()
    logger.info({ jobId: job.id, url: job.url, attempt: job.attempts }, 'Processing job')

    try {
      const results = await captureScreenshots(this.deps.browserPool, job.url, job.options.viewports, {
        waitStrategy: job.options.waitStrategy,
        waitTimeoutMs: job.options.waitTimeoutMs,
        delayAfterLoadMs: job.options.delayAfterLoadMs,
        waitSelector: job.options.waitSelector,
      })

      if (results.length === 0) {
        throw new Error('No screenshots captured')
      }

      this.deps.jobRepo.updateJobStatus(job.id, 'processing_images')

      for (const result of results) {
        const storageKey = buildStorageKey(
          job.entityType,
          job.entityId,
          result.viewport,
          result.width,
          result.height,
          result.format
        )
        const cdnUrl = this.deps.storage.buildUrl(storageKey)
        const contentType = result.format === 'webp' ? 'image/webp' : 'image/png'

        await this.deps.storage.upload(storageKey, result.buffer, contentType)

        this.deps.screenshotRepo.insertScreenshot({
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

      this.deps.jobRepo.updateJobStatus(job.id, 'succeeded')

      const durationMs = Date.now() - startTime
      const screenshots = this.deps.screenshotRepo.getScreenshotsByJobId(job.id)
      logger.info(
        { jobId: job.id, url: job.url, durationMs, screenshots: screenshots.length, attempt: job.attempts },
        'Job succeeded'
      )

      if (job.callbackUrl) {
        this.deps.callbackNotifier.notify(job, screenshots).catch((err) =>
          logger.error({ err, jobId: job.id }, 'Callback failed')
        )
      }
    } catch (error) {
      const { code, message } = classifyError(error)
      const retryDelay = getRetryDelay(code, job.attempts)
      const canRetry = retryDelay !== null && job.attempts < job.maxAttempts

      if (canRetry) {
        const nextRetryAt = new Date(Date.now() + retryDelay!).toISOString()
        this.deps.jobRepo.updateJobStatus(job.id, 'queued', { errorCode: code, errorMessage: message, nextRetryAt })
        logger.warn(
          { jobId: job.id, errorCode: code, attempt: job.attempts, nextRetryAt },
          'Job will retry'
        )
      } else {
        this.deps.jobRepo.updateJobStatus(job.id, 'failed', { errorCode: code, errorMessage: message })
        logger.error(
          { jobId: job.id, errorCode: code, message, durationMs: Date.now() - startTime, attempt: job.attempts },
          'Job failed permanently'
        )

        if (job.callbackUrl) {
          this.deps.callbackNotifier.notify(job, [], code, message).catch((err) =>
            logger.error({ err, jobId: job.id }, 'Failure callback failed')
          )
        }
      }
    }
  }
}
