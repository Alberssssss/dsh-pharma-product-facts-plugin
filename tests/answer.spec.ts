import { describe, expect, it } from 'vitest'
import { finalizeAnswer, type FinalizeInput } from '../src/answer.ts'
import { EvidenceStore, type EvidenceId, type EvidenceRecord } from '../src/source.ts'

function evidence(
  id: string,
  options: Partial<EvidenceRecord> = {},
): EvidenceRecord {
  const product = options.product || '贝乐林'
  const text = options.text || `${product} 适应症为成人2型糖尿病。每日一次。GLP-1 监测。`
  return {
    evidenceId: id as EvidenceId,
    product,
    url: options.url || 'https://www.cde.org.cn/label',
    title: options.title || `${product}说明书`,
    mediaType: options.mediaType || 'text',
    text,
    searchableText: options.searchableText || text,
    retrievedDate: options.retrievedDate || '2026-08-21',
    truncated: options.truncated || false,
  }
}

function setup(...records: EvidenceRecord[]): EvidenceStore {
  const store = new EvidenceStore()
  for (const record of records) store.put('session-a', record)
  return store
}

const id1 = 'ev-111111111111111111111111'
const id2 = 'ev-222222222222222222222222'

function direct(overrides: Partial<FinalizeInput> = {}): FinalizeInput {
  return {
    mode: 'direct_field',
    product: '贝乐林',
    title: '贝乐林',
    facts: [{ field: '适应症', quote: '适应症为成人2型糖尿病。', evidence_id: id1 }],
    ...overrides,
  }
}

describe('canonical fact answers', () => {
  it('renders direct facts, exact sources, CDE/NMPA authority, and source deduplication', () => {
    const first = evidence(id1)
    const second = evidence(id2, {
      url: 'https://www.nmpa.gov.cn/label2',
      title: '国家药监局说明书',
      text: '贝乐林 规格为3 ml。',
    })
    const result = finalizeAnswer(direct({
      title: undefined,
      facts: [
        { field: '适应症', quote: '适应症为成人2型糖尿病。', evidence_id: id1 },
        { field: '规格', quote: '规格为3 ml。', evidence_id: id2 },
      ],
    }), setup(first, second), 'session-a')
    expect(result.mode).toBe('direct_field')
    expect(result.answer).toContain('贝乐林\n\n- 适应症：适应症为成人2型糖尿病。')
    expect(result.answer).toContain('来源：CDE｜贝乐林说明书')
    expect(result.answer).toContain('来源：NMPA｜国家药监局说明书')
    expect(result.source_urls).toEqual([first.url, second.url])

    const duplicate = finalizeAnswer(direct({
      facts: [
        { field: '适应症', quote: '适应症为成人2型糖尿病。', evidence_id: id1 },
        { field: '用法', quote: '每日一次。', evidence_id: id1 },
      ],
    }), setup(first), 'session-a')
    expect(duplicate.source_urls).toEqual([first.url])
    expect(duplicate.answer.match(/来源：/g)).toHaveLength(1)
  })

  it.each([
    ['product_card', 1],
    ['expanded_label', 7],
  ] as const)('renders %s with its HCP note', (mode, count) => {
    const quotes = Array.from({ length: count }, (_, index) => `字段${index + 1}原文。`)
    const text = `贝乐林 ${quotes.join(' ')}`
    const result = finalizeAnswer({
      mode,
      product: '贝乐林',
      title: '贝乐林产品事实',
      facts: quotes.map((quote, index) => ({ field: `字段${index + 1}`, quote, evidence_id: id1 })),
    }, setup(evidence(id1, { text })), 'session-a')
    expect(result.answer).toContain('说明书事实')
    expect(result.answer).toContain('仅供 HCP 参考')
  })

  it('enforces required identity, exact quotes, evidence scope, and mode budgets', () => {
    const store = setup(evidence(id1))
    expect(() => finalizeAnswer(direct({ product: undefined }), store, 'session-a')).toThrow('product is required')
    expect(() => finalizeAnswer(direct({ product: '药'.repeat(101) }), store, 'session-a')).toThrow('exceeds 100')
    expect(() => finalizeAnswer(direct({ title: '另一个标题' }), store, 'session-a')).toThrow('title must contain')
    expect(() => finalizeAnswer(direct({ facts: [] }), store, 'session-a')).toThrow('at least one fact')
    expect(() => finalizeAnswer(direct({ facts: undefined }), store, 'session-a')).toThrow('at least one fact')
    expect(() => finalizeAnswer(direct({ facts: [
      { field: '一', quote: '适应症为成人2型糖尿病。', evidence_id: id1 },
      { field: '二', quote: '每日一次。', evidence_id: id1 },
      { field: '三', quote: 'GLP-1 监测。', evidence_id: id1 },
    ] }), store, 'session-a')).toThrow('2-fact budget')
    expect(() => finalizeAnswer({
      mode: 'product_card', product: '贝乐林', facts: Array.from({ length: 7 }, () => (
        { field: '字段', quote: '适应症为成人2型糖尿病。', evidence_id: id1 }
      )),
    }, store, 'session-a')).toThrow('6-fact budget')
    expect(() => finalizeAnswer({
      mode: 'expanded_label', product: '贝乐林', facts: Array.from({ length: 13 }, () => (
        { field: '字段', quote: '适应症为成人2型糖尿病。', evidence_id: id1 }
      )),
    }, store, 'session-a')).toThrow('12-fact budget')
  })

  it('rejects altered, short, cross-product, cross-session, and malformed evidence', () => {
    const store = setup(evidence(id1))
    expect(() => finalizeAnswer(direct({ facts: [
      { field: '适应症', quote: '模型改写的适应症', evidence_id: id1 },
    ] }), store, 'session-a')).toThrow('not an exact passage')
    expect(() => finalizeAnswer(direct({ facts: [
      { field: '适应症', quote: '短句', evidence_id: id1 },
    ] }), store, 'session-a')).toThrow('at least 4')
    expect(() => finalizeAnswer(direct({ facts: [
      { field: '适应症', quote: '适应症为成人2型糖尿病。', evidence_id: 'bad' },
    ] }), store, 'session-a')).toThrow('unknown in this session')
    expect(() => finalizeAnswer(direct(), store, 'session-b')).toThrow('unknown in this session')
    expect(() => finalizeAnswer(direct(), setup(evidence(id1, { product: '甘美' })), 'session-a'))
      .toThrow('does not match')
    expect(() => finalizeAnswer(direct({ facts: [
      { field: '', quote: '适应症为成人2型糖尿病。', evidence_id: id1 },
    ] }), store, 'session-a')).toThrow('field is required')
    expect(() => finalizeAnswer(direct({ facts: [
      { field: '字段'.repeat(21), quote: '适应症为成人2型糖尿病。', evidence_id: id1 },
    ] }), store, 'session-a')).toThrow('exceeds 40')
    expect(() => finalizeAnswer(direct({ clinical_focus: [{ text: 'x', quote: '每日一次。', evidence_id: id1 }] }), store, 'session-a'))
      .toThrow('accepts facts only')
    expect(() => finalizeAnswer(direct({ label_boundary: {
      questioned_use: '减重', approval_status: 'not_listed', scope_quote: '适应症为成人2型糖尿病。', evidence_id: id1,
    } }), store, 'session-a')).toThrow('accepts facts only')
  })
})

describe('HCP focus answers', () => {
  const focusText = '贝乐林 每日一次。GLP-1 监测。发生率为5%。注意禁忌。'
  const store = setup(evidence(id1, { text: focusText }))

  it('renders 3-5 source-backed focus items and preserves supported numbers and acronyms', () => {
    const result = finalizeAnswer({
      mode: 'hcp_focus_card',
      product: '贝乐林',
      title: '贝乐林 HCP 关注',
      clinical_focus: [
        { text: '关注每日一次用法', quote: '每日一次。', evidence_id: id1 },
        { text: '关注 GLP-1 监测', quote: 'GLP-1 监测。', evidence_id: id1 },
        { text: '关注发生率5%', quote: '发生率为5%。', evidence_id: id1 },
      ],
    }, store, 'session-a')
    expect(result.answer).toContain('临床关注（说明书衍生，非个体化）')
    expect(result.answer).toContain('关注发生率5%')
    expect(result.source_urls).toHaveLength(1)

    const redundantListedBoundary = finalizeAnswer({
      mode: 'hcp_focus_card',
      product: '贝乐林',
      title: '贝乐林 HCP 关注',
      facts: [],
      failure_message: [],
      clinical_focus: [
        { text: '关注每日一次用法', quote: '每日一次。', evidence_id: id1 },
        { text: '关注 GLP-1 监测', quote: 'GLP-1 监测。', evidence_id: id1 },
        { text: '关注发生率5%', quote: '发生率为5%。', evidence_id: id1 },
      ],
      label_boundary: {
        questioned_use: '每日一次',
        approval_status: 'listed',
        scope_quote: '每日一次。',
        evidence_id: id1,
      },
    }, store, 'session-a')
    expect(redundantListedBoundary).toEqual(result)
  })

  it('rejects invalid focus counts, extra fields, budgets, and unsupported tokens', () => {
    const base: FinalizeInput = {
      mode: 'hcp_focus_card', product: '贝乐林', clinical_focus: [
        { text: '一项关注', quote: '每日一次。', evidence_id: id1 },
        { text: '二项关注', quote: '注意禁忌。', evidence_id: id1 },
      ],
    }
    expect(() => finalizeAnswer(base, store, 'session-a')).toThrow('3-5')
    expect(() => finalizeAnswer({ mode: 'hcp_focus_card', product: '贝乐林' }, store, 'session-a')).toThrow('3-5')
    expect(() => finalizeAnswer({ ...base, clinical_focus: Array.from({ length: 6 }, () => (
      { text: '关注点', quote: '注意禁忌。', evidence_id: id1 }
    )) }, store, 'session-a')).toThrow('3-5')
    expect(() => finalizeAnswer({ ...base, facts: [
      { field: '字段', quote: '每日一次。', evidence_id: id1 },
    ], clinical_focus: [...base.clinical_focus!, { text: '三项关注', quote: 'GLP-1 监测。', evidence_id: id1 }] }, store, 'session-a'))
      .toThrow('does not accept facts')
    expect(() => finalizeAnswer({ ...base, label_boundary: {
      questioned_use: '减重', approval_status: 'not_listed', scope_quote: '每日一次。', evidence_id: id1,
    }, clinical_focus: [...base.clinical_focus!, { text: '三项关注', quote: 'GLP-1 监测。', evidence_id: id1 }] }, store, 'session-a'))
      .toThrow('only a redundant listed label_boundary')
    expect(() => finalizeAnswer({ ...base, label_boundary: {
      questioned_use: '发生率', approval_status: 'listed', scope_quote: '发生率为5%。', evidence_id: id1,
    }, clinical_focus: [...base.clinical_focus!, { text: '三项关注', quote: 'GLP-1 监测。', evidence_id: id1 }] }, store, 'session-a'))
      .toThrow('must duplicate one clinical_focus quote and evidence_id')
    expect(() => finalizeAnswer({ ...base, label_boundary: {
      questioned_use: '减重', approval_status: 'listed', scope_quote: '每日一次。', evidence_id: id1,
    }, clinical_focus: [...base.clinical_focus!, { text: '三项关注', quote: 'GLP-1 监测。', evidence_id: id1 }] }, store, 'session-a'))
      .toThrow('listed use is not present in the duplicated clinical_focus quote')
    expect(() => finalizeAnswer({ ...base, clinical_focus: [
      ...base.clinical_focus!, { text: '发生率10%', quote: '发生率为5%。', evidence_id: id1 },
    ] }, store, 'session-a')).toThrow('unsupported token: 10%')
    expect(() => finalizeAnswer({ ...base, clinical_focus: [
      ...base.clinical_focus!, { text: '关注 ABC', quote: 'GLP-1 监测。', evidence_id: id1 },
    ] }, store, 'session-a')).toThrow('unsupported token: ABC')
    expect(() => finalizeAnswer({ ...base, clinical_focus: Array.from({ length: 3 }, () => (
      { text: `关注${'点'.repeat(140)}`, quote: '注意禁忌。', evidence_id: id1 }
    )) }, store, 'session-a')).toThrow('400-character budget')
    expect(() => finalizeAnswer({ ...base, clinical_focus: [
      ...base.clinical_focus!, { text: '点'.repeat(181), quote: '注意禁忌。', evidence_id: id1 },
    ] }, store, 'session-a')).toThrow('exceeds 180')
  })
})

describe('label-boundary answers', () => {
  it('renders listed and not-listed conclusions from complete evidence', () => {
    const listedStore = setup(evidence(id1, {
      text: '贝乐林 适应症为成人2型糖尿病，并用于体重管理。',
    }))
    const listed = finalizeAnswer({
      mode: 'label_boundary', product: '贝乐林', title: '贝乐林', label_boundary: {
        questioned_use: '体重管理', approval_status: 'listed',
        scope_quote: '适应症为成人2型糖尿病，并用于体重管理。', evidence_id: id1,
      },
    }, listedStore, 'session-a')
    expect(listed.answer).toContain('已载明「体重管理」')
    expect(listed.answer).toContain('可表述为')

    const notListedStore = setup(evidence(id1, { text: '贝乐林 适应症为成人2型糖尿病。' }))
    const notListed = finalizeAnswer({
      mode: 'label_boundary', product: '贝乐林', label_boundary: {
        questioned_use: '体重管理', approval_status: 'not_listed',
        scope_quote: '适应症为成人2型糖尿病。', evidence_id: id1,
      },
    }, notListedStore, 'session-a')
    expect(notListed.answer).toContain('未载明「体重管理」')
    expect(notListed.answer).toContain('不应把「体重管理」表述为已获批用途')
  })

  it('rejects incomplete, contradictory, truncated, and mixed boundary inputs', () => {
    const complete = setup(evidence(id1, { text: '贝乐林 适应症为成人2型糖尿病，并用于体重管理。' }))
    const base: FinalizeInput = {
      mode: 'label_boundary', product: '贝乐林', label_boundary: {
        questioned_use: '体重管理', approval_status: 'listed',
        scope_quote: '适应症为成人2型糖尿病，并用于体重管理。', evidence_id: id1,
      },
    }
    expect(() => finalizeAnswer({ ...base, label_boundary: undefined }, complete, 'session-a')).toThrow('is required')
    expect(() => finalizeAnswer({ ...base, facts: [
      { field: '字段', quote: '适应症为成人2型糖尿病，并用于体重管理。', evidence_id: id1 },
    ] }, complete, 'session-a')).toThrow('accepts only')
    expect(() => finalizeAnswer({ ...base, clinical_focus: [
      { text: '关注', quote: '适应症为成人2型糖尿病，并用于体重管理。', evidence_id: id1 },
    ] }, complete, 'session-a')).toThrow('accepts only')
    expect(() => finalizeAnswer({ ...base, label_boundary: {
      ...base.label_boundary!, questioned_use: '未出现用途',
    } }, complete, 'session-a')).toThrow('listed use is not present')
    expect(() => finalizeAnswer({ ...base, label_boundary: {
      ...base.label_boundary!, approval_status: 'not_listed',
    } }, complete, 'session-a')).toThrow('not_listed use is present')
    expect(() => finalizeAnswer({ ...base, label_boundary: {
      ...base.label_boundary!, approval_status: 'not_listed', questioned_use: '未出现用途',
      scope_quote: '适应症为成人2型糖尿病。',
    } }, setup(evidence(id1, {
      text: '贝乐林 适应症为成人2型糖尿病。', truncated: true,
    })), 'session-a')).toThrow('truncated source')
    expect(() => finalizeAnswer({ ...base, label_boundary: {
      ...base.label_boundary!, questioned_use: '用'.repeat(101),
    } }, complete, 'session-a')).toThrow('exceeds 100')
  })
})

describe('safe failure and public-output scanning', () => {
  it('uses supplied 2-4 lines and falls back for other counts', () => {
    const supplied = finalizeAnswer({
      mode: 'boundary_or_failure', failure_message: ['第一行', '', '第二行'],
    }, new EvidenceStore(), 'session-a')
    expect(supplied.answer).toBe('第一行\n第二行\n')
    expect(supplied.source_urls).toEqual([])

    const fallback = finalizeAnswer({
      mode: 'boundary_or_failure', failure_message: ['只有一行'],
    }, new EvidenceStore(), 'session-a')
    expect(fallback.answer).toContain('当前信息不足')
    expect(finalizeAnswer({ mode: 'boundary_or_failure' }, new EvidenceStore(), 'session-a').answer)
      .toContain('请补充明确的产品名称')
  })

  it.each([
    '输出包含 HERMES_HOME',
    '我调用了工具完成核验',
    'tool execution result',
    '本地 /tmp/secret.txt',
    '本地 C:\\secret.txt',
    '本地 \\\\server\\share',
    '本地 file:///secret',
    '本地 ~/secret',
    `secret sk-${'a'.repeat(20)}`,
    `secret ${'a'.repeat(40)}`,
  ])('rejects leaked public text: %s', value => {
    expect(() => finalizeAnswer({
      mode: 'boundary_or_failure', failure_message: [value, '第二行'],
    }, new EvidenceStore(), 'session-a')).toThrow()
  })

  it('rejects oversized public output and source-backed internal markers', () => {
    expect(() => finalizeAnswer({
      mode: 'boundary_or_failure', failure_message: ['文'.repeat(8001), '第二行'],
    }, new EvidenceStore(), 'session-a')).toThrow('8000')

    const store = setup(evidence(id1, { text: '贝乐林 terminal 内部原文。' }))
    expect(() => finalizeAnswer(direct({
      facts: [{ field: '字段', quote: 'terminal 内部原文。', evidence_id: id1 }],
    }), store, 'session-a')).toThrow('forbidden internal marker')
  })
})
