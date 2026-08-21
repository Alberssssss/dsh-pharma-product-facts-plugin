/** Deterministic soft routing for the packaged pharma-product-facts skill. */
import type { Context } from '@deepseek-ai/cordis';
/** Source owner recorded on durable router instructions. */
export declare const ROUTER_SOURCE = "pharma-product-facts";
/** Stable model-visible reminder emitted for a matching user request. */
export declare const ROUTER_HINT: string;
/**
 * Decide whether one user-authored text matches the packaged skill's narrow domain.
 * @param value - user-authored text from the claimed pre-step batch.
 * @returns whether the soft router should recommend loading the skill.
 */
export declare function matchesPharmaProductFacts(value: string): boolean;
/**
 * Register the waterfall listener that appends the soft route after downstream acceptance.
 * @param ctx - plugin context carrying the agent event service.
 */
export declare function registerPharmaProductFactsRouter(ctx: Context): void;
