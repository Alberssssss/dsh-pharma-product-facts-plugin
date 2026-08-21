/** DSH-native official-source and canonical-answer tools. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { finalizeAnswer, type FinalizeInput } from './answer.ts'
import type { ResolvedConfig } from './config.ts'
import {
  EvidenceStore,
  retrieveOfficialSource,
  type FetchSource,
  type SourceDecoders,
} from './source.ts'

/** Model-visible restricted retrieval tool. */
export const FETCH_SOURCE_TOOL = 'pharma_product_facts_fetch_source'
/** Model-visible deterministic answer finalizer. */
export const FINALIZE_TOOL = 'pharma_product_facts_finalize'

/** Test-only dependency overrides for the public source transport and decoders. */
export interface PharmaToolOptions {
  fetchSource?: FetchSource
  decoders?: SourceDecoders
  now?: () => Date
}

/** Derive the evidence isolation key from the current DSH agent. */
export function evidenceScope(agentId: unknown): string {
  return agentId === undefined ? '<unscoped>' : String(agentId)
}

const factSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    field: { type: 'string', required: true, description: 'Short label field, such as 适应症 or 规格.' },
    quote: { type: 'string', required: true, description: 'Exact quotation copied from fetched source text.' },
    evidence_id: { type: 'string', required: true, description: 'Evidence id returned by the source tool in this session.' },
  },
} as const

const focusSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true, description: 'Concise non-individualized HCP focus statement.' },
    quote: { type: 'string', required: true, description: 'Exact supporting quotation from fetched source text.' },
    evidence_id: { type: 'string', required: true, description: 'Evidence id returned by the source tool in this session.' },
  },
} as const

const boundarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    questioned_use: { type: 'string', required: true, description: 'The exact proposed use being checked.' },
    approval_status: {
      type: 'string',
      enum: ['listed', 'not_listed'],
      required: true,
      description: 'Whether the exact proposed use appears in the complete fetched source.',
    },
    scope_quote: { type: 'string', required: true, description: 'Exact quotation of the current approved scope.' },
    evidence_id: { type: 'string', required: true, description: 'Evidence id returned by the source tool in this session.' },
  },
} as const

/**
 * Register both DSH-native tools against one request-scoped evidence store.
 * @param ctx - Cordis context carrying the DSH tool registry.
 * @param config - Complete transport, timeout, and evidence-cache settings.
 * @param options - Optional deterministic transport overrides for tests.
 * @returns The store owned by this plugin fiber.
 */
export function registerPharmaProductFactsTools(
  ctx: Context,
  config: Readonly<ResolvedConfig>,
  options: PharmaToolOptions = {},
): EvidenceStore {
  const store = new EvidenceStore(config.maxEvidenceScopes, config.maxEvidenceRecordsPerScope)
  const now = options.now || (() => new Date())

  ctx.tools.register(defineTool({
    name: FETCH_SOURCE_TOOL,
    description: 'Fetch and extract one public CDE/NMPA HTML, text, JSON, XML, or PDF source. Only official HTTPS regulator hosts are allowed, and the requested product name must occur in the extracted text.',
    parameters: {
      url: { type: 'string', required: true, description: 'Official CDE/NMPA URL discovered with web_search.' },
      product: { type: 'string', required: true, description: 'Exact product identity from the user request.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['verified', 'rejected'], required: true },
          url: { type: 'string', required: true },
          reason: { type: 'string' },
          evidence_id: { type: 'string' },
          title: { type: 'string' },
          media_type: { type: 'string', enum: ['html', 'pdf', 'text'] },
          text: { type: 'string' },
          retrieved_date: { type: 'string' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'verified'
          ? [
              `Verified official source: ${value.title || value.url}`,
              `evidence_id: ${value.evidence_id || ''}`,
              `retrieved_date: ${value.retrieved_date || ''}`,
              value.truncated ? 'Notice: extracted text was truncated; do not infer absence from it.' : '',
              '',
              value.text || '',
            ].filter((part, index) => part.length > 0 || index === 4).join('\n')
          : `Rejected official source: ${value.reason || 'source did not pass validation'}\nURL: ${value.url}`,
      }],
    },
    timeoutMs: config.sourceToolTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const resolved = await retrieveOfficialSource(
        args,
        exec.signal,
        options.fetchSource,
        options.decoders,
        now(),
        config,
      )
      if (resolved.record !== undefined) {
        store.put(evidenceScope(exec.agent?.id), resolved.record)
      }
      return resolved.result
    },
    presentCall: args => ({
      card: 'generic',
      title: `Verify official source for ${args.product}`,
      kind: 'search',
      rawInput: args.url,
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? 'Official source verification failed' : 'Official source verification complete',
      content: result.content,
    }),
  }))

  ctx.tools.register(defineTool({
    name: FINALIZE_TOOL,
    description: 'Validate exact quotations against official evidence fetched in this DSH session and render the canonical public pharma-product-facts answer. Call this last and copy its answer exactly.',
    parameters: {
      mode: {
        type: 'string',
        enum: [
          'direct_field',
          'product_card',
          'hcp_focus_card',
          'label_boundary',
          'expanded_label',
          'boundary_or_failure',
        ],
        required: true,
      },
      product: { type: 'string' },
      title: { type: 'string' },
      facts: { type: 'array', items: factSchema },
      clinical_focus: { type: 'array', items: focusSchema },
      label_boundary: boundarySchema,
      failure_message: { type: 'array', items: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: {
            type: 'string',
            enum: [
              'direct_field',
              'product_card',
              'hcp_focus_card',
              'label_boundary',
              'expanded_label',
              'boundary_or_failure',
            ],
            required: true,
          },
          answer: { type: 'string', required: true },
          source_urls: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.answer }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return finalizeAnswer(args as FinalizeInput, store, evidenceScope(exec.agent?.id))
    },
    presentCall: args => ({
      card: 'generic',
      title: `Finalize pharma facts: ${args.product || args.mode}`,
      kind: 'read',
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? 'Pharma facts validation failed' : 'Pharma facts answer',
      content: result.content,
    }),
  }))

  ctx.effect(() => () => { store.clear() }, 'pharma-product-facts: clear session evidence')
  return store
}
