import { describe, expect, it, vi } from 'vitest'
import {
  EvidenceStore,
  normalizeForMatch,
  normalizeSourceText,
  parseOfficialSourceUrl,
  retrieveOfficialSource,
  type EvidenceId,
  type EvidenceRecord,
  type FetchSource,
  type SourceDecoders,
} from '../src/source.ts'

const signal = new AbortController().signal
const fixedDate = new Date('2026-08-21T01:02:03Z')

function record(id: string, product = '贝乐林'): EvidenceRecord {
  return {
    evidenceId: id as EvidenceId,
    product,
    url: 'https://www.cde.org.cn/source',
    title: '说明书',
    mediaType: 'text',
    text: `${product} 适应症原文`,
    searchableText: `${product} 适应症原文`,
    retrievedDate: '2026-08-21',
    truncated: false,
  }
}

function fetchOnce(response: Response): FetchSource {
  return vi.fn<FetchSource>().mockResolvedValue(response)
}

function textResponse(
  body: BodyInit | null,
  contentType = 'text/plain; charset=utf-8',
  init: ResponseInit = {},
): Response {
  return new Response(body, {
    ...init,
    headers: { 'content-type': contentType, ...init.headers },
  })
}

function minimalPdf(text: string): Uint8Array {
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${text.replace(/[()\\]/g, '\\$&')}) Tj\nET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

describe('official source URL policy', () => {
  it('normalizes trusted exact and subdomain URLs', () => {
    expect(parseOfficialSourceUrl('https://www.cde.org.cn/a#part').toString())
      .toBe('https://www.cde.org.cn/a')
    expect(parseOfficialSourceUrl('https://nmpa.gov.cn/').hostname).toBe('nmpa.gov.cn')
  })

  it.each([
    ['', 'URL length'],
    [`https://www.cde.org.cn/${'a'.repeat(4097)}`, 'URL length'],
    ['not a url', 'invalid'],
    ['http://www.cde.org.cn/a', 'HTTPS'],
    ['https://user@www.cde.org.cn/a', 'credentials'],
    ['https://user:pass@www.cde.org.cn/a', 'credentials'],
    ['https://www.cde.org.cn:444/a', 'default HTTPS port'],
    ['https://evil.example/a', 'allowed CDE/NMPA'],
  ])('rejects unsafe URL %s', (url, message) => {
    expect(() => parseOfficialSourceUrl(url)).toThrow(message)
  })
})

describe('evidence store', () => {
  it('validates bounds, isolates scopes, refreshes records, and evicts oldest data', () => {
    expect(() => new EvidenceStore(0, 1)).toThrow('maxScopes')
    expect(() => new EvidenceStore(1, 0)).toThrow('maxRecordsPerScope')

    const store = new EvidenceStore(2, 2)
    store.put('a', record('ev-000000000000000000000001'))
    store.put('a', record('ev-000000000000000000000002'))
    store.put('a', record('ev-000000000000000000000001', '更新产品'))
    store.put('a', record('ev-000000000000000000000003'))
    expect(store.get('a', 'ev-000000000000000000000002')).toBeUndefined()
    expect(store.get('a', 'ev-000000000000000000000001')?.product).toBe('更新产品')
    expect(store.get('a', 'invalid')).toBeUndefined()
    expect(store.get('missing', 'ev-000000000000000000000001')).toBeUndefined()

    store.put('b', record('ev-000000000000000000000004'))
    store.put('c', record('ev-000000000000000000000005'))
    expect(store.get('a', 'ev-000000000000000000000001')).toBeUndefined()
    store.clear()
    expect(store.get('c', 'ev-000000000000000000000005')).toBeUndefined()
  })
})

describe('source text normalization', () => {
  it('normalizes controls, whitespace, blank paragraphs, and match text', () => {
    expect(normalizeSourceText(' A\r\n\tB\u0000  \n\n\n C ')).toBe('A\nB\n\nC')
    expect(normalizeForMatch(' A\n  B ')).toBe('A B')
  })
})

describe('official source retrieval', () => {
  it('extracts HTML with the default decoder and stores a derived title', async () => {
    const html = '<!doctype html><html><head><title> 贝乐林 说明书 </title><style>x</style></head><body><script>x</script><h1>贝乐林</h1><p>适应症 原文</p></body></html>'
    const fetched = await retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/label', product: '贝乐林' },
      signal,
      fetchOnce(textResponse(html, 'text/html; charset=utf-8')),
      undefined,
      fixedDate,
    )
    expect(fetched.result).toMatchObject({
      status: 'verified', title: '贝乐林 说明书', media_type: 'html', retrieved_date: '2026-08-21', truncated: false,
    })
    expect(fetched.record?.searchableText).toContain('贝乐林')
    expect(fetched.result.status === 'verified' && fetched.result.evidence_id).toMatch(/^ev-[a-f0-9]{24}$/)
  })

  it('extracts a PDF with the bundled JavaScript decoder', async () => {
    const fetched = await retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/files/aspirin.pdf', product: 'Aspirin' },
      signal,
      fetchOnce(textResponse(minimalPdf('Aspirin indication text'), 'application/pdf')),
      undefined,
      fixedDate,
    )
    if (fetched.result.status === 'rejected') throw new Error(fetched.result.reason)
    expect(fetched.result).toMatchObject({ status: 'verified', media_type: 'pdf', title: 'aspirin.pdf' })
    expect(fetched.result.text).toContain('Aspirin')
  })

  it('supports injected PDF, HTML, plain-text, JSON, and XML decoding', async () => {
    const decoders: SourceDecoders = {
      html: value => value.replace(/<[^>]+>/g, ' '),
      pdf: () => Promise.resolve('贝乐林 PDF 正文'),
    }
    const cases: Array<[string, BodyInit, string, string]> = [
      ['application/octet-stream', new TextEncoder().encode('%PDF-1.7 body'), 'pdf', '贝乐林 PDF 正文'],
      ['text/html', '<html><body>贝乐林 HTML 正文</body></html>', 'html', '贝乐林 HTML 正文'],
      ['text/plain; charset=utf-8', '贝乐林 text 正文', 'text', '贝乐林 text 正文'],
      ['application/json', '{"product":"贝乐林"}', 'text', '贝乐林'],
      ['application/xml', '<product>贝乐林</product>', 'text', '贝乐林'],
    ]
    for (const [contentType, body, mediaType, expected] of cases) {
      const fetched = await retrieveOfficialSource(
        { url: 'https://www.nmpa.gov.cn/source', product: '贝乐林' },
        signal,
        fetchOnce(textResponse(body, contentType)),
        decoders,
        fixedDate,
      )
      expect(fetched.result).toMatchObject({ status: 'verified', media_type: mediaType })
      expect(fetched.result.status === 'verified' && fetched.result.text).toContain(expected)
    }
  })

  it('follows a same-origin redirect and rejects malformed redirect responses', async () => {
    const sameOrigin = vi.fn<FetchSource>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/final' } }))
      .mockResolvedValueOnce(textResponse('贝乐林 正文'))
    const followed = await retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/start', product: '贝乐林' }, signal, sameOrigin, undefined, fixedDate,
    )
    expect(followed.result).toMatchObject({ status: 'verified', url: 'https://www.cde.org.cn/final' })

    const missing = await retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/start', product: '贝乐林' },
      signal,
      fetchOnce(new Response(null, { status: 302 })),
    )
    expect(missing.result).toMatchObject({ status: 'rejected', reason: expect.stringContaining('Location') })

    const unsafe = await retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/start', product: '贝乐林' },
      signal,
      fetchOnce(new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })),
    )
    expect(unsafe.result).toMatchObject({ status: 'rejected', reason: expect.stringContaining('allowed CDE/NMPA') })

    const crossOrigin = await retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/start', product: '贝乐林' },
      signal,
      fetchOnce(new Response(null, { status: 302, headers: { location: 'https://api.cde.org.cn/final' } })),
    )
    expect(crossOrigin.result).toMatchObject({ status: 'rejected', reason: 'cross-origin redirects are not followed' })
  })

  it('bounds redirects even when body cancellation fails', async () => {
    const redirect = () => new Response(new ReadableStream({
      cancel() { throw new Error('already closed') },
    }), { status: 302, headers: { location: '/again' } })
    const fetched = await retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/start', product: '贝乐林' },
      signal,
      vi.fn<FetchSource>().mockImplementation(async () => redirect()),
    )
    expect(fetched.result).toMatchObject({ status: 'rejected', reason: 'source exceeded 3 redirects' })
  })

  it.each([
    [textResponse('x', 'text/plain', { status: 404 }), 'HTTP 404'],
    [textResponse('贝乐林', 'image/png'), 'not HTML'],
    [new Response(new Uint8Array([1, 2, 3])), 'not HTML'],
    [textResponse('', 'text/plain'), 'no extractable text'],
    [textResponse('另一个产品', 'text/plain'), 'does not contain'],
  ])('rejects unusable source responses', async (response, message) => {
    const fetched = await retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/source', product: '贝乐林' }, signal, fetchOnce(response), undefined, fixedDate,
    )
    expect(fetched.result).toMatchObject({ status: 'rejected', reason: expect.stringContaining(message) })
  })

  it('rejects unsafe input before network access and validates product identity length', async () => {
    const fetchSource = vi.fn<FetchSource>()
    const unsafe = await retrieveOfficialSource(
      { url: 'https://evil.example/source', product: '贝乐林' }, signal, fetchSource,
    )
    expect(unsafe.result).toMatchObject({ status: 'rejected', reason: expect.stringContaining('allowed') })
    const empty = await retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/source', product: '  ' }, signal, fetchSource,
    )
    expect(empty.result).toMatchObject({ status: 'rejected', reason: expect.stringContaining('empty') })
    const long = await retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/source', product: '药'.repeat(101) }, signal, fetchSource,
    )
    expect(long.result).toMatchObject({ status: 'rejected', reason: expect.stringContaining('too long') })
    expect(fetchSource).not.toHaveBeenCalled()
  })

  it('rejects declared and streamed oversized responses plus empty bodies', async () => {
    const declared = textResponse(null, 'text/plain', { headers: { 'content-length': '12000001' } })
    const declaredResult = await retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/source', product: '贝乐林' }, signal, fetchOnce(declared),
    )
    expect(declaredResult.result).toMatchObject({ status: 'rejected', reason: expect.stringContaining('12000000-byte') })

    const streamed = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(12_000_001))
      },
    }), { headers: { 'content-type': 'text/plain', 'content-length': 'not-a-number' } })
    const streamedResult = await retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/source', product: '贝乐林' }, signal, fetchOnce(streamed),
    )
    expect(streamedResult.result).toMatchObject({ status: 'rejected', reason: expect.stringContaining('12000000-byte') })

    const emptyResult = await retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/source', product: '贝乐林' }, signal, fetchOnce(textResponse(null)),
    )
    expect(emptyResult.result).toMatchObject({ status: 'rejected', reason: expect.stringContaining('no extractable text') })
  })

  it('joins multiple response chunks and truncates long extracted text', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('贝乐林 '))
        controller.enqueue(new TextEncoder().encode('正文'))
        controller.close()
      },
    })
    const joined = await retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/', product: '贝乐林' },
      signal,
      fetchOnce(new Response(body, { headers: { 'content-type': 'text/plain' } })),
      undefined,
      fixedDate,
    )
    expect(joined.result).toMatchObject({ status: 'verified', title: 'www.cde.org.cn' })

    const long = await retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/source', product: '贝乐林' },
      signal,
      fetchOnce(textResponse(`贝乐林${'文'.repeat(180_100)}`)),
      undefined,
      fixedDate,
    )
    expect(long.result).toMatchObject({ status: 'verified', truncated: true })
    expect(long.result.status === 'verified' && long.result.text.length).toBe(180_000)
  })

  it('returns decoder and charset failures without leaking transport details', async () => {
    const decoderFailure = await retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/source', product: '贝乐林' },
      signal,
      fetchOnce(textResponse(new TextEncoder().encode('%PDF-1.7'), 'application/pdf')),
      { html: value => value, pdf: () => { throw new Error('bad pdf') } },
    )
    expect(decoderFailure.result).toMatchObject({ status: 'rejected', reason: expect.stringContaining('bad pdf') })

    const unknownFailure = await retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/source', product: '贝乐林' },
      signal,
      fetchOnce(textResponse('<html>贝乐林</html>', 'text/html')),
      { html: () => { throw 'bad html' }, pdf: () => Promise.resolve('') },
    )
    expect(unknownFailure.result).toMatchObject({ status: 'rejected', reason: expect.stringContaining('unknown decoder') })

    const charsetFailure = await retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/source', product: '贝乐林' },
      signal,
      fetchOnce(textResponse('贝乐林', 'text/plain; charset=unsupported-charset')),
    )
    expect(charsetFailure.result).toMatchObject({ status: 'rejected', reason: expect.stringContaining('decoded') })
  })

  it('propagates transport failure and caller cancellation', async () => {
    await expect(retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/source', product: '贝乐林' },
      signal,
      vi.fn<FetchSource>().mockRejectedValue(new Error('network down')),
    )).rejects.toThrow('network down')

    const controller = new AbortController()
    controller.abort()
    await expect(retrieveOfficialSource(
      { url: 'https://www.cde.org.cn/source', product: '贝乐林' },
      controller.signal,
      vi.fn<FetchSource>().mockImplementation(async (_url, init) => {
        if (init?.signal?.aborted) throw init.signal.reason
        return textResponse('贝乐林')
      }),
    )).rejects.toBeDefined()
  })
})
