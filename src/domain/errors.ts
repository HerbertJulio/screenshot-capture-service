import type { ErrorCode } from './types.js'
import { RETRY_DELAYS, NON_RETRYABLE_ERRORS } from '../config/constants.js'

interface ErrorPattern {
  pattern: RegExp
  code: ErrorCode
}

const ERROR_PATTERNS: ErrorPattern[] = [
  { pattern: /timeout|navigation timeout/i, code: 'timeout' },
  { pattern: /dns|getaddrinfo/i, code: 'dns_failure' },
  { pattern: /econnrefused/i, code: 'connection_refused' },
  { pattern: /ssl|cert/i, code: 'ssl_error' },
  { pattern: /net::err_blocked/i, code: 'blocked_by_firewall' },
  { pattern: /browser.*crash/i, code: 'browser_crash' },
  { pattern: /40[34]/i, code: 'http_4xx' },
  { pattern: /\b5\d{2}\b/, code: 'http_5xx' },
]

export function classifyError(error: unknown): { code: ErrorCode; message: string } {
  const msg = error instanceof Error ? error.message : String(error)

  for (const { pattern, code } of ERROR_PATTERNS) {
    if (pattern.test(msg)) {
      return { code, message: msg }
    }
  }

  return { code: 'internal_error', message: msg }
}

export function getRetryDelay(code: ErrorCode, attempt: number): number | null {
  if ((NON_RETRYABLE_ERRORS as readonly string[]).includes(code)) return null
  const delays = RETRY_DELAYS[code] ?? [10_000]
  return delays[Math.min(attempt - 1, delays.length - 1)] ?? null
}
