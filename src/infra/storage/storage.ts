import type { EntityType, ImageFormat, ViewportName } from '../../domain/types.js'

// Re-export the interface from domain ports for backward compatibility
export type { IStorageProvider as StorageProvider } from '../../domain/ports/storage.port.js'

export function buildStorageKey(
  entityType: EntityType,
  entityId: string,
  viewport: ViewportName,
  width: number,
  height: number,
  format: ImageFormat
): string {
  const safeEntityId = entityId.replace(/[/\\..]+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '_')
  const timestamp = Math.floor(Date.now() / 1000)
  return `screenshots/${entityType}/${safeEntityId}/${viewport}-${width}x${height}-v${timestamp}.${format}`
}
