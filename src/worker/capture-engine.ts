import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import sharp from 'sharp'
import pino from 'pino'
import { getConfig, VIEWPORT_PRESETS, type ViewportName } from '../shared/config.js'
import type { CaptureResult } from '../shared/types/job.types.js'

const logger = pino({ name: 'capture-engine' })

// -- Browser Pool --

let browser: Browser | null = null
let captureCount = 0

async function getBrowser(): Promise<Browser> {
  const config = getConfig()

  if (browser && browser.isConnected() && captureCount < config.BROWSER_RECYCLE_AFTER) {
    return browser
  }

  if (browser) {
    logger.info({ captureCount }, 'Recycling browser')
    await browser.close().catch(() => {})
  }

  browser = await chromium.launch({
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
  captureCount = 0
  logger.info('Browser launched')
  return browser
}

export async function shutdownBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {})
    browser = null
    logger.info('Browser shut down')
  }
}

// -- Blank Page Detection --

async function isBlankPage(screenshotBuffer: Buffer): Promise<boolean> {
  try {
    const stats = await sharp(screenshotBuffer).stats()
    const avgStdDev =
      stats.channels.reduce((sum, c) => sum + c.stdev, 0) / stats.channels.length
    return avgStdDev < 5
  } catch {
    return false
  }
}

// -- Main Capture --

export async function captureScreenshots(
  url: string,
  viewports: ViewportName[],
  options: {
    waitTimeoutMs?: number
    delayAfterLoadMs?: number
    waitSelector?: string | null
  } = {}
): Promise<CaptureResult[]> {
  const config = getConfig()
  const timeoutMs = options.waitTimeoutMs ?? config.CAPTURE_TIMEOUT_MS
  const delayMs = options.delayAfterLoadMs ?? config.CAPTURE_DELAY_AFTER_LOAD_MS
  const results: CaptureResult[] = []

  const b = await getBrowser()
  let context: BrowserContext | null = null

  try {
    context = await b.newContext({
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
      bypassCSP: false,
      permissions: [],
      geolocation: undefined,
      locale: 'en-US',
    })

    const page = await context.newPage()

    // Navigate
    await page.goto(url, {
      timeout: timeoutMs,
      waitUntil: 'domcontentloaded',
    })

    // Wait for delay (allows JS redirects and SPA rendering)
    if (delayMs > 0) await page.waitForTimeout(delayMs)

    // Try networkidle briefly, but don't block on it (SPAs may never reach idle)
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})

    // If custom selector, wait for it
    if (options.waitSelector) {
      await page.waitForSelector(options.waitSelector, { timeout: 5000 }).catch(() => {})
    }

    // Test screenshot for blank detection
    const testViewport = viewports.includes('detail') ? 'detail' : 'card'
    const testPreset = VIEWPORT_PRESETS[testViewport]
    await page.setViewportSize(testPreset)

    let rawScreenshot = await page.screenshot({ type: 'png', fullPage: false })
    let blank = await isBlankPage(rawScreenshot)

    // If blank, scroll and wait more to trigger lazy content
    if (blank) {
      logger.info({ url }, 'Blank page detected, retrying with scroll')
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight)
        return new Promise((r) => setTimeout(r, 500))
      })
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.waitForTimeout(3000)
      rawScreenshot = await page.screenshot({ type: 'png', fullPage: false })
      blank = await isBlankPage(rawScreenshot)
    }

    logger.info({ blank, url }, 'Page ready for capture')

    // Capture each viewport
    for (const vp of viewports) {
      const preset = VIEWPORT_PRESETS[vp]
      await page.setViewportSize(preset)
      await page.waitForTimeout(300) // small settle time after resize

      const pngBuffer = await page.screenshot({ type: 'png', fullPage: false })

      // Convert to WebP
      const webpBuffer = await sharp(pngBuffer)
        .resize(preset.width, preset.height, { fit: 'cover' })
        .webp({ quality: 80 })
        .toBuffer()

      results.push({
        viewport: vp,
        width: preset.width,
        height: preset.height,
        format: 'webp',
        buffer: webpBuffer,
        fileSizeBytes: webpBuffer.byteLength,
      })
    }

    captureCount++
    logger.info(
      { url, viewports, captureCount },
      'Capture completed'
    )

    return results
  } finally {
    if (context) await context.close().catch(() => {})
  }
}
