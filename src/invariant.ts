/** Package-owned router-message invariant. @module dsh-pharma-product-facts/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { ROUTER_HINT, ROUTER_SOURCE } from './router.ts'

const PACKAGE_NAME = 'dsh-pharma-product-facts'

/** Cordis companion plugin name. */
export const name = 'pharma-product-facts-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'user/message'
    || event.data.source.kind !== 'plugin'
    || event.data.source.plugin !== ROUTER_SOURCE) return
  const source = event.data.source
  const blockValue: unknown = event.data.content[0]
  const block = typeof blockValue === 'object' && blockValue !== null
    ? blockValue as Record<string, unknown>
    : undefined
  if (Object.keys(source).length !== 3 || source.form !== 'instructions') {
    fail('router messages must retain only the package instructions source')
  }
  if (event.data.content.length !== 1
    || block === undefined
    || Object.keys(block).length !== 2
    || block.type !== 'text'
    || block.text !== ROUTER_HINT) {
    fail('router messages must retain the exact packaged soft-route instructions')
  }
}

function validateSession(session: Session, fail: InvariantFailure): void {
  for (const event of session.events) validateEvent(event, fail)
}

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [Session, SessionEvent]
    validateEvent(event, fail)
  })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
