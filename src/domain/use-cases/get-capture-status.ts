import type { CaptureJob, ScreenshotRecord } from '../types.js'
import type { IJobRepository } from '../ports/job-repository.port.js'
import type { IScreenshotRepository } from '../ports/screenshot-repository.port.js'

export interface CaptureStatusResult {
  job: CaptureJob
  screenshots: ScreenshotRecord[]
}

export class GetCaptureStatusUseCase {
  constructor(
    private readonly jobRepo: IJobRepository,
    private readonly screenshotRepo: IScreenshotRepository,
  ) {}

  execute(jobId: string): CaptureStatusResult | null {
    const job = this.jobRepo.getJobById(jobId)
    if (!job) return null

    const screenshots = this.screenshotRepo.getScreenshotsByJobId(job.id)
    return { job, screenshots }
  }
}
