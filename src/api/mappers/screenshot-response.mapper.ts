import type { ScreenshotRecord } from '../../domain/types.js'

export function toScreenshotResponse(screenshot: ScreenshotRecord) {
  return {
    viewport: screenshot.viewport,
    image_url: screenshot.cdnUrl,
    width: screenshot.width,
    height: screenshot.height,
    format: screenshot.format,
    file_size_bytes: screenshot.fileSizeBytes,
  }
}
