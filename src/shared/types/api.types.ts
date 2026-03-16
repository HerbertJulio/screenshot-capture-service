import { z } from 'zod'

export const createCaptureSchema = z.object({
  url: z.string().url(),
  entity_type: z.enum(['template', 'application', 'deployment']),
  entity_id: z.string().min(1).max(255),
  callback_url: z.string().url().optional(),
  options: z
    .object({
      viewports: z
        .array(z.enum(['card', 'detail']))
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
        entity_type: z.enum(['template', 'application', 'deployment']),
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
  entity_type: z.enum(['template', 'application', 'deployment']),
  entity_id: z.string().min(1),
  url: z.string().url(),
  timestamp: z.string().optional(),
})

export type WebhookEventInput = z.infer<typeof webhookEventSchema>
