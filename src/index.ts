import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import pino from 'pino'

// Load .env file
try {
  const envPath = resolve(process.cwd(), '.env')
  const envContent = readFileSync(envPath, 'utf-8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex)
    const value = trimmed.slice(eqIndex + 1)
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
} catch {}

import { loadConfig } from './shared/config.js'
import { initDatabase } from './shared/db/database.js'
import { createApp } from './api/server.js'
import { startWorker, stopWorker } from './worker/job-processor.js'
import { shutdownBrowser } from './worker/capture-engine.js'
import { enableLocalStorage } from './processing/storage-uploader.js'

const logger = pino({ name: 'scs' })

async function main() {
  // Load config
  const config = loadConfig()
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'Starting Screenshot Capture Service')

  // Enable local storage if S3 not configured or explicitly requested
  if (config.USE_LOCAL_STORAGE || !config.S3_ENDPOINT) {
    enableLocalStorage()
  }

  // Ensure DB directory exists
  mkdirSync(dirname(config.DB_PATH), { recursive: true })

  // Init database
  initDatabase()
  logger.info('Database initialized')

  // Create API server
  const app = createApp()

  // Start worker (inline, same process)
  startWorker(1000)
  logger.info('Worker started')

  // Start server
  await app.listen({ port: config.PORT, host: config.HOST })
  logger.info({ port: config.PORT, host: config.HOST }, 'API server listening')

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...')
    stopWorker()
    await shutdownBrowser()
    await app.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start')
  process.exit(1)
})
