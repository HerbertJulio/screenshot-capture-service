import type { CaptureJob, CaptureOptions, EntityType, ErrorCode, JobStatus } from '../types.js'

export interface CreateJobParams {
  url: string
  entityType: EntityType
  entityId: string
  options: CaptureOptions
  callbackUrl?: string
  batchId?: string
  priority?: number
}

export interface UpdateStatusExtra {
  errorCode?: ErrorCode
  errorMessage?: string
  nextRetryAt?: string
}

export interface IJobRepository {
  createJob(params: CreateJobParams): CaptureJob
  findActiveJob(entityType: EntityType, entityId: string): CaptureJob | null
  getJobById(id: string): CaptureJob | null
  claimNextJob(workerId: string): CaptureJob | null
  updateJobStatus(id: string, status: JobStatus, extra?: UpdateStatusExtra): void
  recoverStaleJobs(timeoutMinutes?: number): number
  getJobCountByStatus(): Record<string, number>
}
