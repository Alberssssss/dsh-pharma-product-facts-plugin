import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, resolveConfig, type Config } from '../src/config.ts'

describe('plugin configuration', () => {
  it('resolves immutable defaults and accepts a complete valid override', () => {
    expect(resolveConfig()).toEqual(DEFAULT_CONFIG)
    const input: Required<Config> = {
      maxUrlChars: 2048,
      maxResponseBytes: 1_000_000,
      maxSourceChars: 50_000,
      fetchTimeoutMs: 10_000,
      sourceToolTimeoutMs: 12_000,
      maxRedirects: 0,
      maxEvidenceScopes: 8,
      maxEvidenceRecordsPerScope: 4,
      userAgent: 'pharma-test/1.0',
    }
    const resolved = resolveConfig(input)
    expect(resolved).toEqual(input)
    expect(Object.isFrozen(resolved)).toBe(true)
  })

  it.each([
    ['maxUrlChars', 0],
    ['maxResponseBytes', 1.5],
    ['maxSourceChars', Number.POSITIVE_INFINITY],
    ['fetchTimeoutMs', 0],
    ['sourceToolTimeoutMs', 2_147_483_648],
    ['maxEvidenceScopes', -1],
    ['maxEvidenceRecordsPerScope', 0],
  ] as const)('rejects invalid positive setting %s=%s', (name, value) => {
    expect(() => resolveConfig({ [name]: value })).toThrow(name)
  })

  it.each([-1, 1.5])('rejects invalid maxRedirects=%s', (value) => {
    expect(() => resolveConfig({ maxRedirects: value })).toThrow('maxRedirects')
  })

  it('rejects inconsistent timeouts and unsafe User-Agent values', () => {
    expect(() => resolveConfig({ fetchTimeoutMs: 40_000 })).toThrow('sourceToolTimeoutMs')
    expect(() => resolveConfig({ userAgent: '   ' })).toThrow('userAgent')
    expect(() => resolveConfig({ userAgent: 'x'.repeat(513) })).toThrow('userAgent')
    expect(() => resolveConfig({ userAgent: 'bad\nagent' })).toThrow('userAgent')
  })
})
