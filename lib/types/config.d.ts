/** Validated deployment settings for the bundled source and evidence tools. */
import z from '@deepseek-ai/schemastery';
/** User-configurable resource limits for the pharma-product-facts plugin row. */
export interface Config {
    /** Maximum accepted official-source URL length. */
    maxUrlChars?: number;
    /** Maximum response body size in bytes. */
    maxResponseBytes?: number;
    /** Maximum extracted source text returned to the model. */
    maxSourceChars?: number;
    /** HTTP fetch timeout in milliseconds. */
    fetchTimeoutMs?: number;
    /** Overall DSH source-tool timeout in milliseconds. */
    sourceToolTimeoutMs?: number;
    /** Maximum same-origin redirect hops. */
    maxRedirects?: number;
    /** Maximum live agent/session evidence scopes. */
    maxEvidenceScopes?: number;
    /** Maximum retained source records in one agent/session scope. */
    maxEvidenceRecordsPerScope?: number;
    /** Explicit product User-Agent sent to regulator hosts. */
    userAgent?: string;
}
/** Complete settings consumed after package-boundary resolution. */
export interface ResolvedConfig {
    maxUrlChars: number;
    maxResponseBytes: number;
    maxSourceChars: number;
    fetchTimeoutMs: number;
    sourceToolTimeoutMs: number;
    maxRedirects: number;
    maxEvidenceScopes: number;
    maxEvidenceRecordsPerScope: number;
    userAgent: string;
}
/** Stable defaults used by the Cordis schema and direct helper tests. */
export declare const DEFAULT_CONFIG: Readonly<ResolvedConfig>;
/** Cordis configuration schema with deployment-safe defaults. */
export declare const Config: z<Config>;
/**
 * Resolve defaults and reject invalid deployment values before registrations occur.
 * @param input - Cordis row configuration or a direct plugin call input.
 * @returns Complete immutable runtime settings.
 */
export declare function resolveConfig(input?: Config): Readonly<ResolvedConfig>;
