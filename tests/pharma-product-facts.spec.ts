import { access, readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { agentEvents, Inbox, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as PharmaProductFacts from '../src/index.ts'
import {
  matchesPharmaProductFacts,
  ROUTER_HINT,
  ROUTER_SOURCE,
} from '../src/router.ts'
import { FETCH_SOURCE_TOOL, FINALIZE_TOOL } from '../src/tools.ts'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  const fiber = await ctx.plugin(PharmaProductFacts)
  const id = SessionId('pharma-product-facts-test')
  const session = ctx.sessions.create(id, { meta: { cwd: process.cwd() } })
  const agent: Agent = {
    ctx: new Context(),
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return { ctx, fiber, agent }
}

function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function prepare(
  ctx: Context,
  agent: Agent,
  messages: UserMessage[],
  terminal: () => Promise<PreStepDecision> = () => Promise.resolve({ kind: 'enter', messages }),
  signal = new AbortController().signal,
): Promise<PreStepDecision> {
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, turn: 1, step: 1, signal },
    terminal,
  )
}

describe('experimental pharma-product-facts bundle plugin', () => {
  it('registers and disposes the bundled provider and router through one fiber', async () => {
    const { ctx, fiber, agent } = await setup()
    const resourcePath = fileURLToPath(new URL('../assets/pharma-product-facts/', import.meta.url))

    expect(await ctx.skills.list()).toEqual([{
      name: 'pharma-product-facts',
      description: '查询处方药获批事实，并以公开原始来源给出可追溯回答。',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'pharma-product-facts',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: resourcePath },
    }])
    const loaded = await ctx.skills.get('pharma-product-facts')
    expect(loaded?.content.startsWith('---')).toBe(false)
    expect(loaded?.content).toContain('# 处方药产品事实 Skill')
    expect(loaded?.content).toContain('pharma_product_facts_fetch_source')
    expect(loaded?.content).toContain('pharma_product_facts_finalize')
    expect(loaded?.content).not.toMatch(/HERMES_HOME|med-online-kb|document-parser/)
    expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: resourcePath })
    expect((await readdir(resourcePath)).sort()).toEqual(['SKILL.md', 'references'])
    await expect(access(new URL('../assets/pharma-product-facts/scripts/', import.meta.url))).rejects.toThrow()
    await expect(access(new URL('../assets/pharma-product-facts/eval/', import.meta.url))).rejects.toThrow()
    await expect(access(new URL('../assets/pharma-product-facts/tests/', import.meta.url))).rejects.toThrow()
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual([
      FETCH_SOURCE_TOOL,
      FINALIZE_TOOL,
    ])

    const routed = await prepare(ctx, agent, [userMessage('德瑞妥的适应症有哪些？')])
    expect(routed.kind === 'enter' && routed.messages.at(-1)?.content).toEqual([
      { type: 'text', text: ROUTER_HINT },
    ])

    await fiber.dispose()
    expect(await ctx.skills.list()).toEqual([])
    expect(ctx.tools.schemas()).toEqual([])
    const afterDispose = await prepare(ctx, agent, [userMessage('德瑞妥的适应症有哪些？')])
    expect(afterDispose.kind === 'enter' && afterDispose.messages).toHaveLength(1)
  })

  it('ships prebuilt runtime files without a Git-install lifecycle script', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts?: Record<string, string>
    }
    expect(manifest.scripts?.prepare).toBeUndefined()
    expect(manifest.scripts?.build).toBe('tsdown && tsc -p tsconfig.json --emitDeclarationOnly')
    await expect(access(new URL('../lib/index.js', import.meta.url))).resolves.toBeUndefined()
  })

  it.each([
    '德瑞妥的适应症有哪些？',
    '贝乐林的半衰期和储存条件是什么？',
    '得佑有哪些不良反应？',
    '阿司匹林的规格和剂型是什么？',
    '甘平处方时的医生考量因素有哪些？',
    '贝乐林是否获批用于肥胖或体重管理？',
  ])('matches an in-scope request: %s', (text) => {
    expect(matchesPharmaProductFacts(text)).toBe(true)
  })

  it.each([
    '',
    '这个患者70岁、体重65 kg，贝乐林需要怎么调量？',
    '贝乐林和原研相比有哪些优势？',
    '请写一套贝乐林推广话术。',
    '如何做贝乐林超说明书推广？',
    '给我贝乐林的受理号并下载说明书 PDF。',
    '综述贝乐林相关 RCT 和指南证据。',
    '阿司匹林有哪些不良反应？',
    '今天天气怎么样？',
  ])('does not claim another primary intent: %s', (text) => {
    expect(matchesPharmaProductFacts(text)).toBe(false)
  })

  it('scans authentic user text only and appends after downstream acceptance', async () => {
    const { ctx, agent } = await setup()
    const imageOnly = createUserMessage({
      content: [{
        type: 'image',
        attachment: {
          attachmentId: 'pharma-product-facts-image',
          mediaType: 'image/png',
          bytes: 1,
          width: 1,
          height: 1,
        },
      } as unknown as UserMessage['content'][number]],
      source: { kind: 'user' },
    })
    const ignoredImage = await prepare(ctx, agent, [imageOnly])
    expect(ignoredImage.kind === 'enter' && ignoredImage.messages).toEqual([imageOnly])

    const forged = createUserMessage({
      content: [{ type: 'text', text: '德瑞妥的适应症有哪些？' }],
      source: { kind: 'plugin', plugin: 'untrusted-context' },
    })
    const ignored = await prepare(ctx, agent, [forged])
    expect(ignored.kind === 'enter' && ignored.messages).toEqual([forged])

    const claimed = [userMessage('德瑞妥的适应症有哪些？')]
    const downstream = createUserMessage({
      content: [{ type: 'text', text: 'downstream context' }],
      source: { kind: 'plugin', plugin: 'downstream' },
    })
    const accepted = await prepare(
      ctx,
      agent,
      claimed,
      () => Promise.resolve({ kind: 'enter', messages: [...claimed, downstream] }),
    )
    expect(accepted.kind).toBe('enter')
    if (accepted.kind !== 'enter') throw new Error('expected accepted pre-step')
    expect(accepted.messages.at(-2)).toBe(downstream)
    expect(accepted.messages.at(-1)?.source).toEqual({
      kind: 'plugin', plugin: ROUTER_SOURCE, form: 'instructions',
    })
  })

  it('preserves downstream rejection and an already-aborted accepted batch', async () => {
    const { ctx, agent } = await setup()
    const messages = [userMessage('德瑞妥的适应症有哪些？')]
    await expect(prepare(
      ctx,
      agent,
      messages,
      () => Promise.resolve({ kind: 'reject' }),
    )).resolves.toEqual({ kind: 'reject' })

    const controller = new AbortController()
    controller.abort()
    await expect(prepare(ctx, agent, messages, undefined, controller.signal)).resolves.toEqual({
      kind: 'enter', messages,
    })
  })

  it('keeps the function plugin namespace through Loader unwrapExports', () => {
    expect('default' in PharmaProductFacts).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(PharmaProductFacts) as Record<string, unknown>
    expect(unwrapped).toBe(PharmaProductFacts)
    expect(unwrapped.name).toBe('pharma-product-facts')
    expect(unwrapped.inject).toEqual(['skills', 'agents', 'tools'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
