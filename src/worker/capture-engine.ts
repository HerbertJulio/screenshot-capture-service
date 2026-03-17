import type { BrowserContext } from 'playwright'
import sharp from 'sharp'
import pino from 'pino'
import { VIEWPORT_PRESETS } from '../domain/types.js'
import type { ViewportName, CaptureResult } from '../domain/types.js'
import type { BrowserPool } from './browser-pool.js'
import {
  BLANK_PAGE_STDDEV_THRESHOLD,
  VIEWPORT_SETTLE_MS,
  BLANK_PAGE_RETRY_DELAY_MS,
  WEBP_QUALITY,
  NETWORKIDLE_TIMEOUT_MS,
  SCROLL_SETTLE_MS,
} from '../config/constants.js'

const logger = pino({ name: 'capture-engine' })

// -- Blank Page Detection --

async function isBlankPage(screenshotBuffer: Buffer): Promise<boolean> {
  try {
    const stats = await sharp(screenshotBuffer).stats()
    const avgStdDev =
      stats.channels.reduce((sum, c) => sum + c.stdev, 0) / stats.channels.length
    return avgStdDev < BLANK_PAGE_STDDEV_THRESHOLD
  } catch {
    return false
  }
}

// -- Main Capture --

export interface CaptureEngineOptions {
  waitStrategy?: 'networkidle' | 'domcontentloaded' | 'load'
  waitTimeoutMs?: number
  delayAfterLoadMs?: number
  waitSelector?: string | null
}

export async function captureScreenshots(
  browserPool: BrowserPool,
  url: string,
  viewports: ViewportName[],
  options: CaptureEngineOptions = {}
): Promise<CaptureResult[]> {
  const waitStrategy = options.waitStrategy ?? 'domcontentloaded'
  const timeoutMs = options.waitTimeoutMs ?? 30_000
  const delayMs = options.delayAfterLoadMs ?? 2_000
  const results: CaptureResult[] = []

  const browser = await browserPool.getBrowser()
  let context: BrowserContext | null = null

  try {
    context = await browser.newContext({
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
      bypassCSP: false,
      permissions: [],
      geolocation: undefined,
      locale: 'en-US',
    })

    const page = await context.newPage()

    await page.goto(url, {
      timeout: timeoutMs,
      waitUntil: waitStrategy,
    })

    if (delayMs > 0) await page.waitForTimeout(delayMs)

    if (waitStrategy !== 'networkidle') {
      await page.waitForLoadState('networkidle', { timeout: NETWORKIDLE_TIMEOUT_MS }).catch(() => {})
    }

    if (options.waitSelector) {
      await page.waitForSelector(options.waitSelector, { timeout: NETWORKIDLE_TIMEOUT_MS }).catch(() => {})
    }

    // Blank page detection
    const testViewport = viewports.includes('detail') ? 'detail' : 'card'
    const testPreset = VIEWPORT_PRESETS[testViewport]
    await page.setViewportSize(testPreset)

    let rawScreenshot = await page.screenshot({ type: 'png', fullPage: false })
    let blank = await isBlankPage(rawScreenshot)

    if (blank) {
      logger.info({ url }, 'Blank page detected, retrying with scroll')
      await page.evaluate((settleMs) => {
        window.scrollTo(0, document.body.scrollHeight)
        return new Promise((r) => setTimeout(r, settleMs))
      }, SCROLL_SETTLE_MS)
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.waitForTimeout(BLANK_PAGE_RETRY_DELAY_MS)
      rawScreenshot = await page.screenshot({ type: 'png', fullPage: false })
      blank = await isBlankPage(rawScreenshot)
    }

    logger.info({ blank, url }, 'Page ready for capture')

    for (const vp of viewports) {
      const preset = VIEWPORT_PRESETS[vp]
      await page.setViewportSize(preset)
      await page.waitForTimeout(VIEWPORT_SETTLE_MS)

      const pngBuffer = await page.screenshot({ type: 'png', fullPage: false })

      const webpBuffer = await sharp(pngBuffer)
        .resize(preset.width, preset.height, { fit: 'cover' })
        .webp({ quality: WEBP_QUALITY })
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

    logger.info({ url, viewports }, 'Capture completed')
    return results
  } finally {
    if (context) await context.close().catch(() => {})
  }
}
