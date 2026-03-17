import type { Config } from './config/index.js'
import type { IJobRepository } from './domain/ports/job-repository.port.js'
import type { IScreenshotRepository } from './domain/ports/screenshot-repository.port.js'
import type { IStorageProvider } from './domain/ports/storage.port.js'
import { JobRepository } from './infra/database/job-repository.js'
import { ScreenshotRepository } from './infra/database/screenshot-repository.js'
import { S3StorageProvider } from './infra/storage/s3-storage.js'
import { LocalStorageProvider } from './infra/storage/local-storage.js'
import { CreateCaptureUseCase } from './domain/use-cases/create-capture.js'
import { CreateBulkCaptureUseCase } from './domain/use-cases/create-bulk-capture.js'
import { GetCaptureStatusUseCase } from './domain/use-cases/get-capture-status.js'
import { GetEntityScreenshotsUseCase } from './domain/use-cases/get-entity-screenshots.js'
import { DeleteEntityScreenshotsUseCase } from './domain/use-cases/delete-entity-screenshots.js'
import { ProcessWebhookEventUseCase } from './domain/use-cases/process-webhook-event.js'
import { BrowserPool } from './worker/browser-pool.js'
import { CallbackNotifier } from './worker/callback-notifier.js'

export interface Container {
  config: Config
  storage: IStorageProvider
  jobRepo: IJobRepository
  screenshotRepo: IScreenshotRepository
  browserPool: BrowserPool
  callbackNotifier: CallbackNotifier
  useCases: {
    createCapture: CreateCaptureUseCase
    createBulkCapture: CreateBulkCaptureUseCase
    getCaptureStatus: GetCaptureStatusUseCase
    getEntityScreenshots: GetEntityScreenshotsUseCase
    deleteEntityScreenshots: DeleteEntityScreenshotsUseCase
    processWebhookEvent: ProcessWebhookEventUseCase
  }
}

export function createContainer(config: Config): Container {
  // Infrastructure
  const storage = createStorageProvider(config)
  const jobRepo = new JobRepository()
  const screenshotRepo = new ScreenshotRepository()
  const browserPool = new BrowserPool({ recycleAfter: config.BROWSER_RECYCLE_AFTER })
  const callbackNotifier = new CallbackNotifier(config.WEBHOOK_SECRET)

  // Use Cases
  const useCases = {
    createCapture: new CreateCaptureUseCase(jobRepo),
    createBulkCapture: new CreateBulkCaptureUseCase(jobRepo),
    getCaptureStatus: new GetCaptureStatusUseCase(jobRepo, screenshotRepo),
    getEntityScreenshots: new GetEntityScreenshotsUseCase(screenshotRepo),
    deleteEntityScreenshots: new DeleteEntityScreenshotsUseCase(screenshotRepo, storage),
    processWebhookEvent: new ProcessWebhookEventUseCase(jobRepo),
  }

  return { config, storage, jobRepo, screenshotRepo, browserPool, callbackNotifier, useCases }
}

function createStorageProvider(config: Config): IStorageProvider {
  if (config.USE_LOCAL_STORAGE || !config.S3_ENDPOINT) {
    return new LocalStorageProvider()
  }

  return new S3StorageProvider({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET!,
    accessKeyId: config.S3_ACCESS_KEY_ID!,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
    cdnBaseUrl: config.CDN_BASE_URL!,
  })
}
