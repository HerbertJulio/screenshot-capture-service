export interface IStorageProvider {
  upload(key: string, buffer: Buffer, contentType: string): Promise<void>
  delete(key: string): Promise<void>
  buildUrl(key: string): string
}
