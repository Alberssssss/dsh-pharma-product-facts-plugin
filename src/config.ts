/** Validated deployment settings for the bundled source and evidence tools. */

import z from '@deepseek-ai/schemastery'

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647

/** User-configurable resource limits for the pharma-product-facts plugin row. */
export interface Config {
  /** Maximum accepted official-source URL length. */
  maxUrlChars?: number
  /** Maximum response body size in bytes. */
  maxResponseBytes?: number
  /** Maximum extracted source text returned to the model. */
  maxSourceChars?: number
  /** HTTP fetch timeout in milliseconds. */
  fetchTimeoutMs?: number
  /** Overall DSH source-tool timeout in milliseconds. */
  sourceToolTimeoutMs?: number
  /** Maximum same-origin redirect hops. */
  maxRedirects?: number
  /** Maximum live agent/session evidence scopes. */
  maxEvidenceScopes?: number
  /** Maximum retained source records in one agent/session scope. */
  maxEvidenceRecordsPerScope?: number
  /** Explicit product User-Agent sent to regulator hosts. */
  userAgent?: string
}

/** Complete settings consumed after package-boundary resolution. */
export interface ResolvedConfig {
  maxUrlChars: number
  maxResponseBytes: number
  maxSourceChars: number
  fetchTimeoutMs: number
  sourceToolTimeoutMs: number
  maxRedirects: number
  maxEvidenceScopes: number
  maxEvidenceRecordsPerScope: number
  userAgent: string
}

/** Stable defaults used by the Cordis schema and direct helper tests. */
export const DEFAULT_CONFIG: Readonly<ResolvedConfig> = Object.freeze({
  maxUrlChars: 4096,
  maxResponseBytes: 12_000_000,
  maxSourceChars: 180_000,
  fetchTimeoutMs: 30_000,
  sourceToolTimeoutMs: 35_000,
  maxRedirects: 3,
  maxEvidenceScopes: 64,
  maxEvidenceRecordsPerScope: 24,
  userAgent: 'dsh-pharma-product-facts/0.2.1 (+https://github.com/Alberssssss/dsh-pharma-product-facts-plugin)',
})

/** Cordis configuration schema with deployment-safe defaults. */
export const Config: z<Config> = z.object({
  maxUrlChars: z.number().default(DEFAULT_CONFIG.maxUrlChars),
  maxResponseBytes: z.number().default(DEFAULT_CONFIG.maxResponseBytes),
  maxSourceChars: z.number().default(DEFAULT_CONFIG.maxSourceChars),
  fetchTimeoutMs: z.number().default(DEFAULT_CONFIG.fetchTimeoutMs),
  sourceToolTimeoutMs: z.number().default(DEFAULT_CONFIG.sourceToolTimeoutMs),
  maxRedirects: z.number().default(DEFAULT_CONFIG.maxRedirects),
  maxEvidenceScopes: z.number().default(DEFAULT_CONFIG.maxEvidenceScopes),
  maxEvidenceRecordsPerScope: z.number().default(DEFAULT_CONFIG.maxEvidenceRecordsPerScope),
  userAgent: z.string().default(DEFAULT_CONFIG.userAgent),
})

function positiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`pharma-product-facts: ${name} must be a positive integer`)
  }
}

function nonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`pharma-product-facts: ${name} must be a non-negative integer`)
  }
}

function timerDelay(name: string, value: number): void {
  positiveInteger(name, value)
  if (value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(`pharma-product-facts: ${name} exceeds the Node timer limit`)
  }
}

/**
 * Resolve defaults and reject invalid deployment values before registrations occur.
 * @param input - Cordis row configuration or a direct plugin call input.
 * @returns Complete immutable runtime settings.
 */
export function resolveConfig(input: Config = {}): Readonly<ResolvedConfig> {
  const resolved: ResolvedConfig = {
    maxUrlChars: input.maxUrlChars ?? DEFAULT_CONFIG.maxUrlChars,
    maxResponseBytes: input.maxResponseBytes ?? DEFAULT_CONFIG.maxResponseBytes,
    maxSourceChars: input.maxSourceChars ?? DEFAULT_CONFIG.maxSourceChars,
    fetchTimeoutMs: input.fetchTimeoutMs ?? DEFAULT_CONFIG.fetchTimeoutMs,
    sourceToolTimeoutMs: input.sourceToolTimeoutMs ?? DEFAULT_CONFIG.sourceToolTimeoutMs,
    maxRedirects: input.maxRedirects ?? DEFAULT_CONFIG.maxRedirects,
    maxEvidenceScopes: input.maxEvidenceScopes ?? DEFAULT_CONFIG.maxEvidenceScopes,
    maxEvidenceRecordsPerScope: input.maxEvidenceRecordsPerScope ?? DEFAULT_CONFIG.maxEvidenceRecordsPerScope,
    userAgent: input.userAgent ?? DEFAULT_CONFIG.userAgent,
  }
  positiveInteger('maxUrlChars', resolved.maxUrlChars)
  positiveInteger('maxResponseBytes', resolved.maxResponseBytes)
  positiveInteger('maxSourceChars', resolved.maxSourceChars)
  timerDelay('fetchTimeoutMs', resolved.fetchTimeoutMs)
  timerDelay('sourceToolTimeoutMs', resolved.sourceToolTimeoutMs)
  nonNegativeInteger('maxRedirects', resolved.maxRedirects)
  positiveInteger('maxEvidenceScopes', resolved.maxEvidenceScopes)
  positiveInteger('maxEvidenceRecordsPerScope', resolved.maxEvidenceRecordsPerScope)
  if (resolved.sourceToolTimeoutMs < resolved.fetchTimeoutMs) {
    throw new Error('pharma-product-facts: sourceToolTimeoutMs must be at least fetchTimeoutMs')
  }
  if (resolved.userAgent.trim().length === 0 || resolved.userAgent.length > 512 || /[\r\n]/.test(resolved.userAgent)) {
    throw new Error('pharma-product-facts: userAgent must be 1-512 characters without line breaks')
  }
  return Object.freeze(resolved)
}
