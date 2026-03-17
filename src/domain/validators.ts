import { resolve } from 'node:dns/promises'
import { isIP } from 'node:net'
import { getConfig } from '../config/index.js'

const PRIVATE_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc00:/,
  /^fe80:/,
]

function isPrivateIp(ip: string): boolean {
  return PRIVATE_RANGES.some((r) => r.test(ip))
}

interface ValidationResult {
  valid: boolean
  reason?: string
}

async function validateHttpsUrl(
  url: string,
  options: { checkAllowlist: boolean } = { checkAllowlist: false }
): Promise<ValidationResult> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { valid: false, reason: 'Invalid URL format' }
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Only HTTPS URLs are allowed' }
  }

  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'URLs with credentials are not allowed' }
  }

  if (options.checkAllowlist) {
    const config = getConfig()
    const hostname = parsed.hostname
    const matchesAllowlist = config.URL_ALLOWLIST_PATTERNS.some((pattern) =>
      pattern.test(hostname)
    )
    if (!matchesAllowlist) {
      return { valid: false, reason: `Hostname "${hostname}" is not in the allowlist` }
    }
  }

  // DNS rebinding protection
  const hostname = parsed.hostname
  try {
    const ips = isIP(hostname) ? [hostname] : await resolve(hostname)
    for (const ip of ips) {
      if (isPrivateIp(ip)) {
        return { valid: false, reason: `URL resolves to private IP ${ip}` }
      }
    }
  } catch {
    return { valid: false, reason: `DNS resolution failed for ${hostname}` }
  }

  return { valid: true }
}

export async function validateUrl(url: string): Promise<ValidationResult> {
  return validateHttpsUrl(url, { checkAllowlist: true })
}

export async function validateCallbackUrl(url: string): Promise<ValidationResult> {
  return validateHttpsUrl(url, { checkAllowlist: false })
}
