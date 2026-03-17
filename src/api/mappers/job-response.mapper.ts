import type { CaptureJob, ScreenshotRecord } from '../../domain/types.js'
import { toScreenshotResponse } from './screenshot-response.mapper.js'

export function toJobResponse(job: CaptureJob, screenshots: ScreenshotRecord[]) {
  return {
    job_id: job.id,
    status: job.status,
    url: job.url,
    entity_type: job.entityType,
    entity_id: job.entityId,
    attempts: job.attempts,
    created_at: job.createdAt,
    started_at: job.startedAt,
    completed_at: job.completedAt,
    error: job.errorCode
      ? { code: job.errorCode, message: job.errorMessage }
      : undefined,
    results: screenshots.map(toScreenshotResponse),
  }
}

export function toJobCreatedResponse(job: CaptureJob, deduplicated = false) {
  return {
    job_id: job.id,
    status: job.status,
    created_at: job.createdAt,
    estimated_completion_seconds: 30,
    ...(deduplicated && { deduplicated: true }),
  }
}
