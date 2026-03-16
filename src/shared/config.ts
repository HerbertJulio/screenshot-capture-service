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

export const VIEWPORT_PRESETS = {
  card: { width: 1366, height: 768 },
  detail: { width: 1280, height: 800 },
} as const

export type ViewportName = keyof typeof VIEWPORT_PRESETS
