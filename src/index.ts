import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import pino from 'pino'

// Load .env file before anything else
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

import { loadConfig } from './config/index.js'
import { initDatabase } from './infra/database/connection.js'
import { createApp } from './api/server.js'
import { createContainer } from './container.js'
import { JobProcessor } from './worker/job-processor.js'
import { DEFAULT_POLL_MS } from './config/constants.js'

const logger = pino({ name: 'scs' })

async function main() {
  const config = loadConfig()
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'Starting Screenshot Capture Service')

  // Database
  mkdirSync(dirname(config.DB_PATH), { recursive: true })
  initDatabase(config.DB_PATH)
  logger.info('Database initialized')

  // Container (wires all dependencies)
  const container = createContainer(config)

  // API
  const app = createApp(container)

  // Worker
  const worker = new JobProcessor({
    jobRepo: container.jobRepo,
    screenshotRepo: container.screenshotRepo,
    storage: container.storage,
    browserPool: container.browserPool,
    callbackNotifier: container.callbackNotifier,
    maxConcurrent: config.MAX_CONCURRENT_CAPTURES,
  })
  worker.start(DEFAULT_POLL_MS)
  logger.info('Worker started')

  // Listen
  await app.listen({ port: config.PORT, host: config.HOST })
  logger.info({ port: config.PORT, host: config.HOST }, 'API server listening')

  // Graceful shutdown
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'Shutting down...')
    worker.stop()
    await container.browserPool.shutdown()
    await app.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGHUP', () => shutdown('SIGHUP'))
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start')
  process.exit(1)
})
