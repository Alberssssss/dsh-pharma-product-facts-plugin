/** Deterministic answer validation and rendering over fetched official evidence. */

import type { EvidenceRecord, EvidenceStore } from './source.ts'
import { normalizeForMatch } from './source.ts'

/** Supported public-answer layouts. */
export type AnswerMode =
  | 'direct_field'
  | 'product_card'
  | 'hcp_focus_card'
  | 'label_boundary'
  | 'expanded_label'
  | 'boundary_or_failure'

/** One exact source quotation rendered as a label fact. */
export interface FactInput {
  field: string
  quote: string
  evidence_id: string
}

/** One source-backed HCP focus statement. */
export interface FocusInput {
  text: string
  quote: string
  evidence_id: string
}

/** Inputs for checking whether one proposed use appears in the fetched label. */
export interface LabelBoundaryInput {
  questioned_use: string
  approval_status: 'listed' | 'not_listed'
  scope_quote: string
  evidence_id: string
}

/** Model-supplied structured data accepted by the finalizer tool. */
export interface FinalizeInput {
  mode: AnswerMode
  product?: string
  title?: string
  facts?: FactInput[]
  clinical_focus?: FocusInput[]
  label_boundary?: LabelBoundaryInput
  failure_message?: string[]
}

/** Canonical value returned by the finalizer tool. */
export interface FinalizedAnswer {
  mode: AnswerMode
  answer: string
  source_urls: string[]
}

const DEFAULT_FAILURE_LINES = [
  '当前信息不足以安全完成这项核验，暂不把未核实内容作为确定事实。',
  '请补充明确的产品名称，或提供可公开核验的 CDE/NMPA 来源后继续。',
] as const

const FORBIDDEN_MARKERS = [
  'HERMES_HOME', '.hermes', 'workspace', '.env', 'auth.json', 'job.json',
  'fetch_facts.py', 'finalize_public_answer.py', 'render_public_answer.py',
  'validate_public_answer.py', 'web_search', 'pharma_product_facts_fetch_source',
  'pharma_product_facts_finalize', 'skill_view', 'skill_manage', 'terminal',
  'request-id', 'request_id', 'job-id', 'job_id', 'API key', 'Authorization',
  'Bearer ', 'WISEDIAG_API_KEY', 'canonical', 'finalizer', '校验已通过', '逐字交付',
] as const

const PROCESS_PATTERNS = [
  /我(?:调用|运行|执行|读取|检查)了?(?:工具|命令|脚本|文件|配置)/i,
  /(?:tool|command|script) (?:call|execution|result)/i,
] as const

function line(value: string): string {
  return normalizeForMatch(value)
}

function requiredLine(value: string | undefined, name: string, maxChars: number): string {
  const normalized = line(value || '')
  if (normalized.length === 0) throw new Error(`${name} is required`)
  if (normalized.length > maxChars) throw new Error(`${name} exceeds ${maxChars} characters`)
  return normalized
}

function evidenceFor(
  store: EvidenceStore,
  scope: string,
  evidenceId: string,
  product: string,
  quote: string,
): { record: EvidenceRecord; quote: string } {
  const record = store.get(scope, evidenceId)
  if (record === undefined) throw new Error(`evidence_id is unknown in this session: ${evidenceId}`)
  if (record.product !== product) throw new Error('evidence product does not match the requested product')
  const normalizedQuote = requiredLine(quote, 'quote', 4000)
  if (normalizedQuote.length < 4) throw new Error('quote must contain at least 4 characters')
  if (!record.searchableText.includes(normalizedQuote)) {
    throw new Error('quote is not an exact passage from the fetched official source')
  }
  return { record, quote: normalizedQuote }
}

function sourceAuthority(record: EvidenceRecord): string {
  const hostname = new URL(record.url).hostname.toLowerCase()
  return hostname === 'cde.org.cn' || hostname.endsWith('.cde.org.cn') ? 'CDE' : 'NMPA'
}

function sourceLine(record: EvidenceRecord): string {
  return `来源：${sourceAuthority(record)}｜${record.title}｜${record.url}｜访问日期 ${record.retrievedDate}`
}

function uniqueRecords(records: readonly EvidenceRecord[]): EvidenceRecord[] {
  const seen = new Set<string>()
  return records.filter(record => {
    if (seen.has(record.evidenceId)) return false
    seen.add(record.evidenceId)
    return true
  })
}

function scanPublicAnswer(answer: string): void {
  if (answer.length > 8000) throw new Error('public answer exceeds 8000 characters')
  for (const marker of FORBIDDEN_MARKERS) {
    if (answer.toLowerCase().includes(marker.toLowerCase())) {
      throw new Error(`public answer contains forbidden internal marker: ${marker}`)
    }
  }
  for (const pattern of PROCESS_PATTERNS) {
    if (pattern.test(answer)) throw new Error('public answer narrates internal execution')
  }
  const withoutUrls = answer.replace(/https:\/\/[^\s)]+/gi, '<PUBLIC_URL>')
  const localPathPatterns = [
    /(?:^|[\s(])\/(?:cfs|home|tmp|var|Users)\/[^\s)]*/im,
    /[A-Za-z]:\\[^\s]+/,
    /\\\\[^\s]+/,
    /file:\/\/[^\s]+/i,
    /~[/\\][^\s]+/,
  ] as const
  if (localPathPatterns.some(pattern => pattern.test(withoutUrls))) {
    throw new Error('public answer contains a local path')
  }
  if (/\bsk-[A-Za-z0-9_-]{12,}\b/.test(withoutUrls)
    || /\b[0-9a-fA-F]{40,}\b/.test(withoutUrls)) {
    throw new Error('public answer contains a secret-like value')
  }
}

function failureAnswer(input: FinalizeInput): FinalizedAnswer {
  const supplied = (input.failure_message || []).map(line).filter(Boolean)
  const lines = supplied.length >= 2 && supplied.length <= 4
    ? supplied
    : [...DEFAULT_FAILURE_LINES]
  const answer = `${lines.join('\n')}\n`
  scanPublicAnswer(answer)
  return { mode: 'boundary_or_failure', answer, source_urls: [] }
}

function identity(input: FinalizeInput): { product: string; title: string } {
  const product = requiredLine(input.product, 'product', 100)
  const title = requiredLine(input.title || product, 'title', 160)
  if (!title.includes(product)) throw new Error('title must contain the requested product identity')
  return { product, title }
}

function factRows(
  input: FinalizeInput,
  store: EvidenceStore,
  scope: string,
  product: string,
): { lines: string[]; records: EvidenceRecord[] } {
  const facts = input.facts || []
  const limit = input.mode === 'direct_field' ? 2 : input.mode === 'expanded_label' ? 12 : 6
  if (facts.length === 0) throw new Error(`${input.mode} requires at least one fact`)
  if (facts.length > limit) throw new Error(`${input.mode} exceeds its ${limit}-fact budget`)
  const records: EvidenceRecord[] = []
  const lines = facts.map((fact, index) => {
    const field = requiredLine(fact.field, `facts[${index}].field`, 40)
    const verified = evidenceFor(store, scope, fact.evidence_id, product, fact.quote)
    records.push(verified.record)
    return `${field}：${verified.quote}`
  })
  return { lines, records }
}

function unsupportedTokens(text: string, quote: string): string[] {
  const tokens = [
    ...(text.match(/\d+(?:[.,]\d+)?%?/g) || []),
    ...(text.match(/\b[A-Z][A-Z0-9-]{1,}\b/g) || []),
  ]
  return [...new Set(tokens)].filter(token => !quote.toLowerCase().includes(token.toLowerCase()))
}

function focusRows(
  input: FinalizeInput,
  store: EvidenceStore,
  scope: string,
  product: string,
): { lines: string[]; records: EvidenceRecord[] } {
  const focus = input.clinical_focus || []
  if (focus.length < 3 || focus.length > 5) throw new Error('hcp_focus_card requires 3-5 clinical_focus items')
  const records: EvidenceRecord[] = []
  const lines = focus.map((item, index) => {
    const text = requiredLine(item.text, `clinical_focus[${index}].text`, 180)
    const verified = evidenceFor(store, scope, item.evidence_id, product, item.quote)
    const unsupported = unsupportedTokens(text, verified.quote)
    if (unsupported.length > 0) {
      throw new Error(`clinical_focus[${index}] introduces unsupported token: ${unsupported.join(', ')}`)
    }
    records.push(verified.record)
    return text
  })
  if (lines.join('').length > 400) throw new Error('hcp_focus_card exceeds its 400-character budget')
  return { lines, records }
}

function renderSources(records: readonly EvidenceRecord[]): { lines: string[]; urls: string[] } {
  const unique = uniqueRecords(records)
  return {
    lines: unique.map(sourceLine),
    urls: unique.map(record => record.url),
  }
}

function standardAnswer(
  input: FinalizeInput,
  store: EvidenceStore,
  scope: string,
): FinalizedAnswer {
  if ((input.clinical_focus || []).length > 0 || input.label_boundary !== undefined) {
    throw new Error(`${input.mode} accepts facts only`)
  }
  const { product, title } = identity(input)
  const facts = factRows(input, store, scope, product)
  const sources = renderSources(facts.records)
  const lines = [title, '']
  if (input.mode !== 'direct_field') lines.push('说明书事实')
  lines.push(...facts.lines.map(value => `- ${value}`), '', ...sources.lines)
  if (input.mode !== 'direct_field') {
    lines.push('仅供 HCP 参考；个体化用药以核准说明书及医师/药师判断为准。')
  }
  const answer = `${lines.join('\n').trim()}\n`
  scanPublicAnswer(answer)
  return { mode: input.mode, answer, source_urls: sources.urls }
}

function hcpFocusAnswer(
  input: FinalizeInput,
  store: EvidenceStore,
  scope: string,
): FinalizedAnswer {
  const { product, title } = identity(input)
  if ((input.facts || []).length > 0 || input.label_boundary !== undefined) {
    throw new Error('hcp_focus_card accepts clinical_focus only')
  }
  const focus = focusRows(input, store, scope, product)
  const sources = renderSources(focus.records)
  const answer = `${[
    title,
    '',
    '临床关注（说明书衍生，非个体化）',
    ...focus.lines.map(value => `- ${value}`),
    '',
    ...sources.lines,
    '仅供 HCP 参考；个体化用药以核准说明书及医师/药师判断为准。',
  ].join('\n').trim()}\n`
  scanPublicAnswer(answer)
  return { mode: 'hcp_focus_card', answer, source_urls: sources.urls }
}

function labelBoundaryAnswer(
  input: FinalizeInput,
  store: EvidenceStore,
  scope: string,
): FinalizedAnswer {
  const { product } = identity(input)
  if ((input.facts || []).length > 0 || (input.clinical_focus || []).length > 0) {
    throw new Error('label_boundary accepts only label_boundary evidence')
  }
  const boundary = input.label_boundary
  if (boundary === undefined) throw new Error('label_boundary is required')
  const questionedUse = requiredLine(boundary.questioned_use, 'label_boundary.questioned_use', 100)
  const verified = evidenceFor(store, scope, boundary.evidence_id, product, boundary.scope_quote)
  const questionedUsePresent = verified.record.searchableText.includes(questionedUse)
  if (boundary.approval_status === 'listed' && !questionedUsePresent) {
    throw new Error('listed use is not present in the fetched official source')
  }
  if (boundary.approval_status === 'not_listed') {
    if (verified.record.truncated) throw new Error('absence cannot be established from a truncated source')
    if (questionedUsePresent) throw new Error('not_listed use is present in the fetched official source')
  }
  const conclusion = boundary.approval_status === 'listed'
    ? `${product}当前说明书已载明「${questionedUse}」。`
    : `${product}当前说明书未载明「${questionedUse}」。`
  const wording = boundary.approval_status === 'listed'
    ? `可表述为：${product}核准说明书载明「${questionedUse}」；具体适用范围以说明书原文为准。`
    : `不应把「${questionedUse}」表述为已获批用途；可仅复述当前核准范围。`
  const sources = renderSources([verified.record])
  const answer = `${[
    `核对结论：${conclusion}`,
    `当前核准范围：${verified.quote}`,
    `建议表述：${wording}`,
    '',
    ...sources.lines,
  ].join('\n').trim()}\n`
  scanPublicAnswer(answer)
  return { mode: 'label_boundary', answer, source_urls: sources.urls }
}

/**
 * Validate evidence relationships and render one canonical public answer.
 * @param input - Structured finalizer arguments supplied by the model.
 * @param store - Plugin-owned evidence store.
 * @param scope - Current DSH agent/session scope.
 * @returns Canonical answer and its derived source URLs.
 */
export function finalizeAnswer(
  input: FinalizeInput,
  store: EvidenceStore,
  scope: string,
): FinalizedAnswer {
  if (input.mode === 'boundary_or_failure') return failureAnswer(input)
  if (input.mode === 'hcp_focus_card') return hcpFocusAnswer(input, store, scope)
  if (input.mode === 'label_boundary') return labelBoundaryAnswer(input, store, scope)
  return standardAnswer(input, store, scope)
}
