/** Restricted official-source retrieval and request-scoped evidence storage. */
import { type ResolvedConfig } from './config.ts';
/** Source transport limits selected at the plugin configuration boundary. */
export type SourceLimits = Pick<ResolvedConfig, 'maxUrlChars' | 'maxResponseBytes' | 'maxSourceChars' | 'fetchTimeoutMs' | 'maxRedirects' | 'userAgent'>;
declare const evidenceIdBrand: unique symbol;
/** Content-derived identifier returned by the source tool. */
export type EvidenceId = string & {
    readonly [evidenceIdBrand]: true;
};
/** One verified public document retained for a later finalizer call. */
export interface EvidenceRecord {
    evidenceId: EvidenceId;
    product: string;
    url: string;
    title: string;
    mediaType: 'html' | 'pdf' | 'text';
    text: string;
    searchableText: string;
    retrievedDate: string;
    truncated: boolean;
}
/** Canonical successful result from restricted retrieval. */
export interface VerifiedSourceResult {
    status: 'verified';
    evidence_id: EvidenceId;
    url: string;
    title: string;
    media_type: EvidenceRecord['mediaType'];
    text: string;
    retrieved_date: string;
    truncated: boolean;
}
/** Safe rejection for an untrusted or unusable source. */
export interface RejectedSourceResult {
    status: 'rejected';
    url: string;
    reason: string;
}
/** Result returned by the restricted source tool. */
export type SourceResult = VerifiedSourceResult | RejectedSourceResult;
/** Injectable document decoders used by deterministic tests. */
export interface SourceDecoders {
    html(value: string): string;
    pdf(value: Uint8Array): Promise<string>;
}
/** Minimal fetch interface used by the source retriever. */
export type FetchSource = (input: string | URL, init?: RequestInit) => Promise<Response>;
/** Bounded per-session evidence cache; source text never crosses session scopes. */
export declare class EvidenceStore {
    private readonly maxScopes;
    private readonly maxRecordsPerScope;
    private readonly scopes;
    /**
     * @param maxScopes - Maximum live session scopes retained by this plugin fiber.
     * @param maxRecordsPerScope - Maximum verified documents retained per scope.
     */
    constructor(maxScopes?: number, maxRecordsPerScope?: number);
    /** Store one verified document and refresh its scope's recency. */
    put(scope: string, record: EvidenceRecord): void;
    /** Resolve one evidence id inside its originating session scope. */
    get(scope: string, evidenceId: string): EvidenceRecord | undefined;
    /** Drop all retained public-source text when the owning plugin fiber stops. */
    clear(): void;
}
/**
 * Parse and enforce the source tool's fixed public-regulator URL policy.
 * @param value - Model-supplied source URL discovered through DSH web search.
 * @param maxUrlChars - Validated deployment URL length limit.
 * @returns A normalized HTTPS URL without a fragment.
 */
export declare function parseOfficialSourceUrl(value: string, maxUrlChars?: number): URL;
/** Normalize public text while preserving useful paragraph boundaries. */
export declare function normalizeSourceText(value: string): string;
/** Normalize a quote and a document to the same exact-match representation. */
export declare function normalizeForMatch(value: string): string;
/**
 * Retrieve and extract one public CDE/NMPA HTML, text, or PDF source.
 * @param input - URL and exact requested product identity.
 * @param signal - Caller cancellation propagated from the DSH tool runtime.
 * @param fetchSource - Injectable HTTP implementation.
 * @param decoders - Injectable HTML/PDF decoders.
 * @param now - Retrieval time used only for the public access date.
 * @param limits - Validated deployment limits.
 * @returns Verified evidence or a safe domain rejection.
 */
export declare function retrieveOfficialSource(input: {
    url: string;
    product: string;
}, signal: AbortSignal, fetchSource?: FetchSource, decoders?: SourceDecoders, now?: Date, limits?: SourceLimits): Promise<{
    result: SourceResult;
    record?: EvidenceRecord;
}>;
export {};
