/** Deterministic answer validation and rendering over fetched official evidence. */
import type { EvidenceStore } from './source.ts';
/** Supported public-answer layouts. */
export type AnswerMode = 'direct_field' | 'product_card' | 'hcp_focus_card' | 'label_boundary' | 'expanded_label' | 'boundary_or_failure';
/** One exact source quotation rendered as a label fact. */
export interface FactInput {
    field: string;
    quote: string;
    evidence_id: string;
}
/** One source-backed HCP focus statement. */
export interface FocusInput {
    text: string;
    quote: string;
    evidence_id: string;
}
/** Inputs for checking whether one proposed use appears in the fetched label. */
export interface LabelBoundaryInput {
    questioned_use: string;
    approval_status: 'listed' | 'not_listed';
    scope_quote: string;
    evidence_id: string;
}
/** Model-supplied structured data accepted by the finalizer tool. */
export interface FinalizeInput {
    mode: AnswerMode;
    product?: string;
    title?: string;
    facts?: FactInput[];
    clinical_focus?: FocusInput[];
    label_boundary?: LabelBoundaryInput;
    failure_message?: string[];
}
/** Canonical value returned by the finalizer tool. */
export interface FinalizedAnswer {
    mode: AnswerMode;
    answer: string;
    source_urls: string[];
}
/**
 * Validate evidence relationships and render one canonical public answer.
 * @param input - Structured finalizer arguments supplied by the model.
 * @param store - Plugin-owned evidence store.
 * @param scope - Current DSH agent/session scope.
 * @returns Canonical answer and its derived source URLs.
 */
export declare function finalizeAnswer(input: FinalizeInput, store: EvidenceStore, scope: string): FinalizedAnswer;
