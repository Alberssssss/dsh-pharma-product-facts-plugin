import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import * as PharmaProductFactsInvariant from '../src/invariant.ts'
import { ROUTER_HINT, ROUTER_SOURCE } from '../src/router.ts'

function routerMessage(text = ROUTER_HINT, form: 'instructions' | 'catalog' = 'instructions') {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: ROUTER_SOURCE, form },
  })
}

describe('pharma-product-facts invariant companion', () => {
  it('accepts exact router messages and validates seeded sessions on creation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(PharmaProductFactsInvariant)
    const session = ctx.sessions.create(SessionId('pharma-router-valid'))
    expect(() => session.append('user/message', routerMessage(), { surfaceOp: 'append' })).not.toThrow()
    expect(() => ctx.sessions.create(SessionId('pharma-router-valid-seed'), {
      seed: [...session.events],
    })).not.toThrow()
    expect(() => session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'unrelated' }],
      source: { kind: 'plugin', plugin: 'other' },
    }), { surfaceOp: 'append' })).not.toThrow()
  })

  it('rejects altered source metadata and altered router text', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(PharmaProductFactsInvariant)
    const session = ctx.sessions.create(SessionId('pharma-router-invalid'))
    expect(() => session.append('user/message', routerMessage(ROUTER_HINT, 'catalog'), {
      surfaceOp: 'append',
    })).toThrow(new InvariantError(
      'dsh-pharma-product-facts',
      'router messages must retain only the package instructions source',
    ))
    expect(() => session.append('user/message', routerMessage('altered'), {
      surfaceOp: 'append',
    })).toThrow(/exact packaged soft-route instructions/)
    const nonObjectBlock = {
      ...routerMessage(),
      content: [null],
    } as unknown as UserMessage
    expect(() => session.append('user/message', nonObjectBlock, {
      surfaceOp: 'append',
    })).toThrow(/exact packaged soft-route instructions/)
  })

  it('rejects a malformed package-owned message already present at installation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry)
    const session = ctx.sessions.create(SessionId('pharma-router-preexisting'))
    session.append('user/message', routerMessage('altered'), { surfaceOp: 'append' })
    await expect(ctx.plugin(PharmaProductFactsInvariant)).rejects.toThrow(
      /exact packaged soft-route instructions/,
    )
  })
})
