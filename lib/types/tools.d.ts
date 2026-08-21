/** DSH-native official-source and canonical-answer tools. */
import type { Context } from '@deepseek-ai/cordis';
import type { ResolvedConfig } from './config.ts';
import { EvidenceStore, type FetchSource, type SourceDecoders } from './source.ts';
/** Model-visible restricted retrieval tool. */
export declare const FETCH_SOURCE_TOOL = "pharma_product_facts_fetch_source";
/** Model-visible deterministic answer finalizer. */
export declare const FINALIZE_TOOL = "pharma_product_facts_finalize";
/** Test-only dependency overrides for the public source transport and decoders. */
export interface PharmaToolOptions {
    fetchSource?: FetchSource;
    decoders?: SourceDecoders;
    now?: () => Date;
}
/** Derive the evidence isolation key from the current DSH agent. */
export declare function evidenceScope(agentId: unknown): string;
/**
 * Register both DSH-native tools against one request-scoped evidence store.
 * @param ctx - Cordis context carrying the DSH tool registry.
 * @param config - Complete transport, timeout, and evidence-cache settings.
 * @param options - Optional deterministic transport overrides for tests.
 * @returns The store owned by this plugin fiber.
 */
export declare function registerPharmaProductFactsTools(ctx: Context, config: Readonly<ResolvedConfig>, options?: PharmaToolOptions): EvidenceStore;
