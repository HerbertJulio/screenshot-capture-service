import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  API_KEY: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(1),

  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  CDN_BASE_URL: z.string().url().optional(),

  USE_LOCAL_STORAGE: z.coerce.boolean().default(false),

  DB_PATH: z.string().default('./data/scs.db'),

  CAPTURE_TIMEOUT_MS: z.coerce.number().default(30_000),
  CAPTURE_DELAY_AFTER_LOAD_MS: z.coerce.number().default(2000),
  MAX_CONCURRENT_CAPTURES: z.coerce.number().default(3),
  BROWSER_RECYCLE_AFTER: z.coerce.number().default(10),

  URL_ALLOWLIST_PATTERNS: z
    .string()
    .default('.*')
    .transform((v) => v.split(',').map((p) => new RegExp(p.trim()))),
}).superRefine((data, ctx) => {
  if (!data.USE_LOCAL_STORAGE && data.S3_ENDPOINT) {
    const required = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'CDN_BASE_URL'] as const
    for (const field of required) {
      if (!data[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} is required when USE_LOCAL_STORAGE is false and S3_ENDPOINT is set`,
          path: [field],
        })
      }
    }
  }
})

export type Config = z.infer<typeof envSchema>

let _config: Config | null = null

export function loadConfig(): Config {
  if (_config) return _config
  _config = envSchema.parse(process.env)
  return _config
}

export function getConfig(): Config {
  if (!_config) throw new Error('Config not loaded. Call loadConfig() first.')
  return _config
}
