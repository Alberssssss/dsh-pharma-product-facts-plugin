import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig, type Config } from '../src/config.ts'
import {
  evidenceScope,
  FETCH_SOURCE_TOOL,
  FINALIZE_TOOL,
  registerPharmaProductFactsTools,
} from '../src/tools.ts'

const toolSignal = new AbortController().signal

async function mount(
  options: Parameters<typeof registerPharmaProductFactsTools>[2] = {},
  config: Config = {},
) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const store = registerPharmaProductFactsTools(ctx, resolveConfig(config), options)
  let counter = 0
  const call = (name: string, args: unknown): Promise<ToolExecutionResult> => ctx.tools.execute({
    signal: toolSignal,
    callId: CallId(`pharma-tool-${++counter}`),
    name,
    arguments: args,
  })
  return { ctx, store, call }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DSH-native pharma tools', () => {
  it('registers stable schemas and executes verified fetch then canonical finalization', async () => {
    const fetchSource = vi.fn().mockResolvedValue(new Response(
      '<html><head><title>贝乐林说明书</title></head><body>贝乐林 适应症为成人2型糖尿病。</body></html>',
      { headers: { 'content-type': 'text/html' } },
    ))
    const { ctx, call } = await mount({
      fetchSource,
      now: () => new Date('2026-08-21T00:00:00Z'),
    })
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual([FETCH_SOURCE_TOOL, FINALIZE_TOOL])
    expect(ctx.tools.schemas().find(schema => schema.name === FINALIZE_TOOL)).toMatchObject({
      description: expect.stringContaining('Mode-specific fields are mutually exclusive'),
      parameters: {
        properties: {
          mode: { description: expect.stringContaining('send only that mode') },
          facts: { description: expect.stringContaining('Only for direct_field') },
          clinical_focus: { description: expect.stringContaining('omit facts, label_boundary') },
          label_boundary: { description: expect.stringContaining('Only for label_boundary') },
          failure_message: { description: expect.stringContaining('Only for boundary_or_failure') },
        },
      },
    })

    const fetched = await call(FETCH_SOURCE_TOOL, {
      url: 'https://www.cde.org.cn/label',
      product: '贝乐林',
    })
    expect(fetched.isError).toBe(false)
    if (fetched.isError) throw new Error('expected verified source')
    expect(fetched.value).toMatchObject({ status: 'verified', retrieved_date: '2026-08-21' })
    expect(fetched.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Verified official source') })
    const value = fetched.value as { evidence_id: string }

    const finalized = await call(FINALIZE_TOOL, {
      mode: 'direct_field',
      product: '贝乐林',
      title: '贝乐林',
      facts: [{
        field: '适应症',
        quote: '适应症为成人2型糖尿病。',
        evidence_id: value.evidence_id,
      }],
    })
    expect(finalized.isError).toBe(false)
    if (finalized.isError) throw new Error('expected finalized answer')
    expect(finalized.value).toMatchObject({ mode: 'direct_field', source_urls: ['https://www.cde.org.cn/label'] })
    expect(finalized.content).toEqual([{ type: 'text', text: (finalized.value as { answer: string }).answer }])
  })

  it('renders safe rejections and contains finalizer relationship failures', async () => {
    const { call } = await mount({
      fetchSource: vi.fn().mockResolvedValue(new Response('贝乐林', {
        headers: { 'content-type': 'text/plain' },
      })),
    })
    const rejected = await call(FETCH_SOURCE_TOOL, {
      url: 'https://evil.example/label', product: '贝乐林',
    })
    expect(rejected.isError).toBe(false)
    if (rejected.isError) throw new Error('expected safe domain rejection')
    expect(rejected.value).toMatchObject({ status: 'rejected' })
    expect(rejected.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Rejected official source') })

    const failed = await call(FINALIZE_TOOL, {
      mode: 'direct_field', product: '贝乐林', facts: [{
        field: '适应症', quote: '适应症为成人2型糖尿病。', evidence_id: 'ev-000000000000000000000000',
      }],
    })
    expect(failed.isError).toBe(true)
    expect(failed.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('unknown in this session') })
  })

  it('uses global fetch and current time when no test overrides are supplied', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('贝乐林 当前说明书原文。', {
      headers: { 'content-type': 'text/plain' },
    })))
    const { call } = await mount()
    const fetched = await call(FETCH_SOURCE_TOOL, {
      url: 'https://www.cde.org.cn/source', product: '贝乐林',
    })
    expect(fetched.isError).toBe(false)
    if (fetched.isError) throw new Error('expected global fetch success')
    expect((fetched.value as { retrieved_date: string }).retrieved_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('applies configured response, text, redirect, and User-Agent limits', async () => {
    const oversized = await mount({
      fetchSource: vi.fn().mockResolvedValue(new Response('贝乐林正文', {
        headers: { 'content-type': 'text/plain', 'content-length': '15' },
      })),
    }, { maxResponseBytes: 10 })
    const rejected = await oversized.call(FETCH_SOURCE_TOOL, {
      url: 'https://www.cde.org.cn/source', product: '贝乐林',
    })
    expect(rejected.isError).toBe(false)
    expect(rejected.value).toMatchObject({ status: 'rejected', reason: expect.stringContaining('10-byte') })

    const fetchSource = vi.fn().mockResolvedValue(new Response('贝乐林正文内容超过限制', {
      headers: { 'content-type': 'text/plain' },
    }))
    const bounded = await mount({ fetchSource }, {
      maxSourceChars: 8,
      userAgent: 'pharma-config-test/1.0',
    })
    const truncated = await bounded.call(FETCH_SOURCE_TOOL, {
      url: 'https://www.cde.org.cn/source', product: '贝乐林',
    })
    expect(truncated.value).toMatchObject({ status: 'verified', truncated: true, text: '贝乐林正文内容超' })
    expect(fetchSource).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      headers: expect.objectContaining({ 'user-agent': 'pharma-config-test/1.0' }),
    }))

    const noRedirect = await mount({
      fetchSource: vi.fn().mockResolvedValue(new Response(null, {
        status: 302, headers: { location: '/next' },
      })),
    }, { maxRedirects: 0 })
    const redirect = await noRedirect.call(FETCH_SOURCE_TOOL, {
      url: 'https://www.cde.org.cn/start', product: '贝乐林',
    })
    expect(redirect.value).toMatchObject({ status: 'rejected', reason: 'source exceeded 0 redirects' })
  })

  it('turns the configured fetch timeout into a contained tool failure', async () => {
    const fetchSource = vi.fn((_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      signal?.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    }))
    const { call } = await mount({ fetchSource }, {
      fetchTimeoutMs: 10,
      sourceToolTimeoutMs: 100,
    })
    const timedOut = await call(FETCH_SOURCE_TOOL, {
      url: 'https://www.cde.org.cn/source', product: '贝乐林',
    })
    expect(timedOut.isError).toBe(true)
    expect(fetchSource).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed model arguments before tool execution', async () => {
    const fetchSource = vi.fn()
    const { call } = await mount({ fetchSource })
    const missing = await call(FETCH_SOURCE_TOOL, { url: 'https://www.cde.org.cn/source' })
    expect(missing.isError).toBe(true)
    expect(fetchSource).not.toHaveBeenCalled()
    const nestedExtra = await call(FINALIZE_TOOL, {
      mode: 'direct_field',
      facts: [{ field: '适应症', quote: '原文', evidence_id: 'ev-000000000000000000000000', extra: true }],
    })
    expect(nestedExtra.isError).toBe(true)
  })

  it('declares generic UI intents and conservative concurrency', async () => {
    const { ctx } = await mount({}, { sourceToolTimeoutMs: 40_000 })
    const fetchTool = ctx.tools.get(FETCH_SOURCE_TOOL)
    const finalizeTool = ctx.tools.get(FINALIZE_TOOL)
    expect(fetchTool?.timeoutMs).toBe(40_000)
    expect(fetchTool?.isConcurrencySafe?.({ url: 'https://www.cde.org.cn/a', product: '贝乐林' })).toBe(false)
    expect(finalizeTool?.isConcurrencySafe?.({ mode: 'boundary_or_failure' })).toBe(false)
    expect(fetchTool?.presentCall?.({ url: 'https://www.cde.org.cn/a', product: '贝乐林' }))
      .toMatchObject({ card: 'generic', kind: 'search', title: expect.stringContaining('贝乐林') })
    expect(finalizeTool?.presentCall?.({ mode: 'boundary_or_failure' }))
      .toMatchObject({ card: 'generic', kind: 'read', title: expect.stringContaining('boundary_or_failure') })

    const success = { isError: false, content: [{ type: 'text', text: 'ok' }] } as const
    const failure = { isError: true, content: [{ type: 'text', text: 'bad' }] } as const
    const fetchArgs = { url: 'https://www.cde.org.cn/a', product: '贝乐林' }
    const finalizeArgs = { mode: 'boundary_or_failure' }
    expect(fetchTool?.presentResult?.(fetchArgs, success)).toMatchObject({ title: 'Official source verification complete' })
    expect(fetchTool?.presentResult?.(fetchArgs, failure)).toMatchObject({ title: 'Official source verification failed' })
    expect(finalizeTool?.presentResult?.(finalizeArgs, success)).toMatchObject({ title: 'Pharma facts answer' })
    expect(finalizeTool?.presentResult?.(finalizeArgs, failure)).toMatchObject({ title: 'Pharma facts validation failed' })

    expect(fetchTool?.output.render(fetchArgs, {
      status: 'verified', url: 'https://www.cde.org.cn/a', truncated: true,
    })).toEqual([{ type: 'text', text: expect.stringContaining('Notice: extracted text was truncated') }])
    expect(fetchTool?.output.render(fetchArgs, {
      status: 'rejected', url: 'https://www.cde.org.cn/a',
    })).toEqual([{ type: 'text', text: expect.stringContaining('source did not pass validation') }])
  })

  it('uses deterministic scope keys', () => {
    expect(evidenceScope(undefined)).toBe('<unscoped>')
    expect(evidenceScope('session-a')).toBe('session-a')
    expect(evidenceScope(42)).toBe('42')
  })
})
