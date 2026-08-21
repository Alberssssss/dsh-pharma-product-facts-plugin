/** Restricted official-source retrieval and request-scoped evidence storage. */

import { createHash } from 'node:crypto'
import { convert } from 'html-to-text'
import { extractText, getDocumentProxy } from 'unpdf'
import { DEFAULT_CONFIG, type ResolvedConfig } from './config.ts'

const TRUSTED_REGULATOR_DOMAINS = ['cde.org.cn', 'nmpa.gov.cn'] as const
const EVIDENCE_ID_PATTERN = /^ev-[a-f0-9]{24}$/

/** Source transport limits selected at the plugin configuration boundary. */
export type SourceLimits = Pick<ResolvedConfig,
  'maxUrlChars' | 'maxResponseBytes' | 'maxSourceChars' | 'fetchTimeoutMs' | 'maxRedirects' | 'userAgent'>

declare const evidenceIdBrand: unique symbol

/** Content-derived identifier returned by the source tool. */
export type EvidenceId = string & { readonly [evidenceIdBrand]: true }

/** One verified public document retained for a later finalizer call. */
export interface EvidenceRecord {
  evidenceId: EvidenceId
  product: string
  url: string
  title: string
  mediaType: 'html' | 'pdf' | 'text'
  text: string
  searchableText: string
  retrievedDate: string
  truncated: boolean
}

/** Canonical successful result from restricted retrieval. */
export interface VerifiedSourceResult {
  status: 'verified'
  evidence_id: EvidenceId
  url: string
  title: string
  media_type: EvidenceRecord['mediaType']
  text: string
  retrieved_date: string
  truncated: boolean
}

/** Safe rejection for an untrusted or unusable source. */
export interface RejectedSourceResult {
  status: 'rejected'
  url: string
  reason: string
}

/** Result returned by the restricted source tool. */
export type SourceResult = VerifiedSourceResult | RejectedSourceResult

/** Injectable document decoders used by deterministic tests. */
export interface SourceDecoders {
  html(value: string): string
  pdf(value: Uint8Array): Promise<string>
}

/** Minimal fetch interface used by the source retriever. */
export type FetchSource = (input: string | URL, init?: RequestInit) => Promise<Response>

/** Bounded per-session evidence cache; source text never crosses session scopes. */
export class EvidenceStore {
  private readonly scopes = new Map<string, Map<EvidenceId, EvidenceRecord>>()

  /**
   * @param maxScopes - Maximum live session scopes retained by this plugin fiber.
   * @param maxRecordsPerScope - Maximum verified documents retained per scope.
   */
  constructor(
    private readonly maxScopes = DEFAULT_CONFIG.maxEvidenceScopes,
    private readonly maxRecordsPerScope = DEFAULT_CONFIG.maxEvidenceRecordsPerScope,
  ) {
    if (!Number.isInteger(maxScopes) || maxScopes < 1) throw new Error('maxScopes must be a positive integer')
    if (!Number.isInteger(maxRecordsPerScope) || maxRecordsPerScope < 1) {
      throw new Error('maxRecordsPerScope must be a positive integer')
    }
  }

  /** Store one verified document and refresh its scope's recency. */
  put(scope: string, record: EvidenceRecord): void {
    let records = this.scopes.get(scope)
    if (records === undefined) {
      records = new Map()
    } else {
      this.scopes.delete(scope)
    }
    records.delete(record.evidenceId)
    records.set(record.evidenceId, record)
    while (records.size > this.maxRecordsPerScope) {
      records.delete(records.keys().next().value as EvidenceId)
    }
    this.scopes.set(scope, records)
    while (this.scopes.size > this.maxScopes) {
      this.scopes.delete(this.scopes.keys().next().value as string)
    }
  }

  /** Resolve one evidence id inside its originating session scope. */
  get(scope: string, evidenceId: string): EvidenceRecord | undefined {
    if (!EVIDENCE_ID_PATTERN.test(evidenceId)) return undefined
    return this.scopes.get(scope)?.get(evidenceId as EvidenceId)
  }

  /** Drop all retained public-source text when the owning plugin fiber stops. */
  clear(): void {
    this.scopes.clear()
  }
}

function trustedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return TRUSTED_REGULATOR_DOMAINS.some(domain =>
    normalized === domain || normalized.endsWith(`.${domain}`))
}

/**
 * Parse and enforce the source tool's fixed public-regulator URL policy.
 * @param value - Model-supplied source URL discovered through DSH web search.
 * @param maxUrlChars - Validated deployment URL length limit.
 * @returns A normalized HTTPS URL without a fragment.
 */
export function parseOfficialSourceUrl(value: string, maxUrlChars = DEFAULT_CONFIG.maxUrlChars): URL {
  if (value.length === 0 || value.length > maxUrlChars) throw new Error('URL length is outside the accepted range')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('source URL is invalid')
  }
  if (url.protocol !== 'https:') throw new Error('source URL must use HTTPS')
  if (url.username || url.password) throw new Error('source URL must not contain credentials')
  if (url.port && url.port !== '443') throw new Error('source URL must use the default HTTPS port')
  if (!trustedHostname(url.hostname)) throw new Error('source URL is not on an allowed CDE/NMPA host')
  url.hash = ''
  return url
}

/** Normalize public text while preserving useful paragraph boundaries. */
export function normalizeSourceText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .split('\n')
    .map(line => line.replace(/[\t ]+/g, ' ').trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1]?.length !== 0))
    .join('\n')
    .trim()
}

/** Normalize a quote and a document to the same exact-match representation. */
export function normalizeForMatch(value: string): string {
  return normalizeSourceText(value).replace(/\s+/g, ' ').trim()
}

function decodedTitle(html: string): string {
  const match = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i.exec(html)
  return match === null ? '' : normalizeForMatch(convert(match[1]!, { wordwrap: false }))
}

function charsetOf(contentType: string): string {
  return /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1]?.trim() || 'utf-8'
}

async function defaultPdfDecoder(value: Uint8Array): Promise<string> {
  const document = await getDocumentProxy(value)
  const extracted = await extractText(document, { mergePages: true })
  return extracted.text as string
}

const DEFAULT_DECODERS: SourceDecoders = {
  html: value => convert(value, {
    wordwrap: false,
    selectors: [
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'noscript', format: 'skip' },
    ],
  }),
  pdf: defaultPdfDecoder,
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The response is already unusable; cancellation is best-effort socket cleanup.
  }
}

async function readCapped(response: Response, maxResponseBytes: number): Promise<Uint8Array | undefined> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxResponseBytes) {
    await cancelBody(response)
    return undefined
  }
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    size += part.value.byteLength
    if (size > maxResponseBytes) {
      await reader.cancel()
      return undefined
    }
    chunks.push(part.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function mediaTypeOf(contentType: string, bytes: Uint8Array): EvidenceRecord['mediaType'] | undefined {
  const normalized = contentType.toLowerCase()
  const magic = new TextDecoder('ascii').decode(bytes.subarray(0, 16)).trimStart().toLowerCase()
  if (normalized.includes('application/pdf') || magic.startsWith('%pdf-')) return 'pdf'
  if (normalized.includes('text/html') || normalized.includes('application/xhtml+xml')
    || magic.startsWith('<!doctype') || magic.startsWith('<html')) return 'html'
  if (normalized.startsWith('text/') || normalized.includes('application/json')
    || normalized.includes('application/xml')) return 'text'
  return undefined
}

function fallbackTitle(url: URL): string {
  const leaf = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) || url.hostname)
  return normalizeForMatch(leaf)
}

function evidenceIdOf(url: string, product: string, searchableText: string): EvidenceId {
  const digest = createHash('sha256')
    .update(url)
    .update('\0')
    .update(product)
    .update('\0')
    .update(searchableText)
    .digest('hex')
    .slice(0, 24)
  return `ev-${digest}` as EvidenceId
}

function rejected(url: string, reason: string): RejectedSourceResult {
  return { status: 'rejected', url, reason }
}

/**
 * Retrieve and extract one public CDE/NMPA HTML, text, or PDF source.
 * @param input - URL and exact requested product identity.
 * @param signal - Caller cancellation propagated from the DSH tool runtime.
 * @param fetchSource - Injectable HTTP implementation.
 * @param decoders - Injectable HTML/PDF decoders.
 * @param now - Retrieval time used only for the public access date.
 * @param limits - Validated deployment limits.
 * @returns Verified evidence or a safe domain rejection.
 */
export async function retrieveOfficialSource(
  input: { url: string; product: string },
  signal: AbortSignal,
  fetchSource: FetchSource = globalThis.fetch,
  decoders: SourceDecoders = DEFAULT_DECODERS,
  now: Date = new Date(),
  limits: SourceLimits = DEFAULT_CONFIG,
): Promise<{ result: SourceResult; record?: EvidenceRecord }> {
  let current: URL
  try {
    current = parseOfficialSourceUrl(input.url, limits.maxUrlChars)
  } catch (error: unknown) {
    return { result: rejected(input.url, (error as Error).message) }
  }
  const product = normalizeForMatch(input.product)
  if (product.length === 0 || product.length > 100) {
    return { result: rejected(current.toString(), 'product identity is empty or too long') }
  }

  const timeout = AbortSignal.timeout(limits.fetchTimeoutMs)
  const combined = AbortSignal.any([signal, timeout])
  let response!: Response
  for (let redirects = 0; redirects <= limits.maxRedirects; redirects++) {
    response = await fetchSource(current, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/pdf,text/plain,application/json;q=0.8',
        'user-agent': limits.userAgent,
      },
      signal: combined,
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    if (redirects === limits.maxRedirects) {
      await cancelBody(response)
      return { result: rejected(current.toString(), `source exceeded ${limits.maxRedirects} redirects`) }
    }
    const location = response.headers.get('location')
    if (location === null) {
      await cancelBody(response)
      return { result: rejected(current.toString(), 'redirect response has no Location header') }
    }
    let target: URL
    try {
      target = parseOfficialSourceUrl(new URL(location, current).toString(), limits.maxUrlChars)
    } catch (error: unknown) {
      await cancelBody(response)
      return { result: rejected(current.toString(), (error as Error).message) }
    }
    if (target.origin !== current.origin) {
      await cancelBody(response)
      return { result: rejected(current.toString(), 'cross-origin redirects are not followed') }
    }
    await cancelBody(response)
    current = target
  }
  if (!response.ok) {
    await cancelBody(response)
    return { result: rejected(current.toString(), `official source returned HTTP ${response.status}`) }
  }

  const bytes = await readCapped(response, limits.maxResponseBytes)
  if (bytes === undefined) {
    return { result: rejected(current.toString(), `official source exceeds the ${limits.maxResponseBytes}-byte limit`) }
  }
  const contentType = response.headers.get('content-type') || ''
  const mediaType = mediaTypeOf(contentType, bytes)
  if (mediaType === undefined) return { result: rejected(current.toString(), 'official source is not HTML, text, JSON, XML, or PDF') }

  let decoded: string
  let title = ''
  try {
    if (mediaType === 'pdf') {
      decoded = await decoders.pdf(bytes)
    } else {
      const sourceText = new TextDecoder(charsetOf(contentType), { fatal: true }).decode(bytes)
      title = mediaType === 'html' ? decodedTitle(sourceText) : ''
      decoded = mediaType === 'html' ? decoders.html(sourceText) : sourceText
    }
  } catch (error: unknown) {
    return {
      result: rejected(
        current.toString(),
        `official source could not be decoded: ${error instanceof Error ? error.message : 'unknown decoder error'}`,
      ),
    }
  }
  const normalized = normalizeSourceText(decoded)
  const searchable = normalizeForMatch(normalized)
  if (searchable.length === 0) return { result: rejected(current.toString(), 'official source contains no extractable text') }
  if (!searchable.toLocaleLowerCase('zh-CN').includes(product.toLocaleLowerCase('zh-CN'))) {
    return { result: rejected(current.toString(), `official source does not contain the requested product identity “${product}”`) }
  }

  const truncated = normalized.length > limits.maxSourceChars
  const text = truncated ? normalized.slice(0, limits.maxSourceChars) : normalized
  const recordSearchable = normalizeForMatch(text)
  const url = current.toString()
  const evidenceId = evidenceIdOf(url, product, searchable)
  const record: EvidenceRecord = {
    evidenceId,
    product,
    url,
    title: title || fallbackTitle(current),
    mediaType,
    text,
    searchableText: recordSearchable,
    retrievedDate: now.toISOString().slice(0, 10),
    truncated,
  }
  return {
    record,
    result: {
      status: 'verified',
      evidence_id: evidenceId,
      url: record.url,
      title: record.title,
      media_type: record.mediaType,
      text: record.text,
      retrieved_date: record.retrievedDate,
      truncated: record.truncated,
    },
  }
}
