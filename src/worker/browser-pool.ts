import { chromium, type Browser } from 'playwright'
import pino from 'pino'

const logger = pino({ name: 'browser-pool' })

export interface BrowserPoolConfig {
  recycleAfter: number
}

export class BrowserPool {
  private browser: Browser | null = null
  private captureCount = 0
  private browserLock: Promise<Browser> | null = null

  constructor(private readonly config: BrowserPoolConfig) {}

  async getBrowser(): Promise<Browser> {
    if (this.browserLock) return this.browserLock

    if (this.browser && this.browser.isConnected() && this.captureCount < this.config.recycleAfter) {
      this.captureCount++
      return this.browser
    }

    this.browserLock = this.launchBrowser()
    return this.browserLock
  }

  async shutdown(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {})
      this.browser = null
      logger.info('Browser shut down')
    }
  }

  private async launchBrowser(): Promise<Browser> {
    if (this.browser) {
      logger.info({ captureCount: this.captureCount }, 'Recycling browser')
      await this.browser.close().catch(() => {})
    }

    const browser = await chromium.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--no-first-run',
        '--single-process',
      ],
    })

    this.browser = browser
    this.captureCount = 1
    this.browserLock = null
    logger.info('Browser launched')
    return browser
  }
}
