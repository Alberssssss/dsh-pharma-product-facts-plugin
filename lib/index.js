import { r as registerPharmaProductFactsRouter } from "./router-DW9bEapZ.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BUNDLED_SKILL_RANK } from "@deepseek-ai/dsh-skill";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash } from "node:crypto";
import { convert } from "html-to-text";
import { extractText, getDocumentProxy } from "unpdf";
//#region src/config.ts
/** Validated deployment settings for the bundled source and evidence tools. */
const MAX_NODE_TIMER_DELAY_MS = 2147483647;
/** Stable defaults used by the Cordis schema and direct helper tests. */
const DEFAULT_CONFIG = Object.freeze({
	maxUrlChars: 4096,
	maxResponseBytes: 12e6,
	maxSourceChars: 18e4,
	fetchTimeoutMs: 3e4,
	sourceToolTimeoutMs: 35e3,
	maxRedirects: 3,
	maxEvidenceScopes: 64,
	maxEvidenceRecordsPerScope: 24,
	userAgent: "dsh-pharma-product-facts/0.2 (+https://github.com/Alberssssss/dsh-pharma-product-facts-plugin)"
});
/** Cordis configuration schema with deployment-safe defaults. */
const Config = z.object({
	maxUrlChars: z.number().default(DEFAULT_CONFIG.maxUrlChars),
	maxResponseBytes: z.number().default(DEFAULT_CONFIG.maxResponseBytes),
	maxSourceChars: z.number().default(DEFAULT_CONFIG.maxSourceChars),
	fetchTimeoutMs: z.number().default(DEFAULT_CONFIG.fetchTimeoutMs),
	sourceToolTimeoutMs: z.number().default(DEFAULT_CONFIG.sourceToolTimeoutMs),
	maxRedirects: z.number().default(DEFAULT_CONFIG.maxRedirects),
	maxEvidenceScopes: z.number().default(DEFAULT_CONFIG.maxEvidenceScopes),
	maxEvidenceRecordsPerScope: z.number().default(DEFAULT_CONFIG.maxEvidenceRecordsPerScope),
	userAgent: z.string().default(DEFAULT_CONFIG.userAgent)
});
function positiveInteger(name, value) {
	if (!Number.isInteger(value) || value < 1) throw new Error(`pharma-product-facts: ${name} must be a positive integer`);
}
function nonNegativeInteger(name, value) {
	if (!Number.isInteger(value) || value < 0) throw new Error(`pharma-product-facts: ${name} must be a non-negative integer`);
}
function timerDelay(name, value) {
	positiveInteger(name, value);
	if (value > MAX_NODE_TIMER_DELAY_MS) throw new Error(`pharma-product-facts: ${name} exceeds the Node timer limit`);
}
/**
* Resolve defaults and reject invalid deployment values before registrations occur.
* @param input - Cordis row configuration or a direct plugin call input.
* @returns Complete immutable runtime settings.
*/
function resolveConfig(input = {}) {
	const resolved = {
		maxUrlChars: input.maxUrlChars ?? DEFAULT_CONFIG.maxUrlChars,
		maxResponseBytes: input.maxResponseBytes ?? DEFAULT_CONFIG.maxResponseBytes,
		maxSourceChars: input.maxSourceChars ?? DEFAULT_CONFIG.maxSourceChars,
		fetchTimeoutMs: input.fetchTimeoutMs ?? DEFAULT_CONFIG.fetchTimeoutMs,
		sourceToolTimeoutMs: input.sourceToolTimeoutMs ?? DEFAULT_CONFIG.sourceToolTimeoutMs,
		maxRedirects: input.maxRedirects ?? DEFAULT_CONFIG.maxRedirects,
		maxEvidenceScopes: input.maxEvidenceScopes ?? DEFAULT_CONFIG.maxEvidenceScopes,
		maxEvidenceRecordsPerScope: input.maxEvidenceRecordsPerScope ?? DEFAULT_CONFIG.maxEvidenceRecordsPerScope,
		userAgent: input.userAgent ?? DEFAULT_CONFIG.userAgent
	};
	positiveInteger("maxUrlChars", resolved.maxUrlChars);
	positiveInteger("maxResponseBytes", resolved.maxResponseBytes);
	positiveInteger("maxSourceChars", resolved.maxSourceChars);
	timerDelay("fetchTimeoutMs", resolved.fetchTimeoutMs);
	timerDelay("sourceToolTimeoutMs", resolved.sourceToolTimeoutMs);
	nonNegativeInteger("maxRedirects", resolved.maxRedirects);
	positiveInteger("maxEvidenceScopes", resolved.maxEvidenceScopes);
	positiveInteger("maxEvidenceRecordsPerScope", resolved.maxEvidenceRecordsPerScope);
	if (resolved.sourceToolTimeoutMs < resolved.fetchTimeoutMs) throw new Error("pharma-product-facts: sourceToolTimeoutMs must be at least fetchTimeoutMs");
	if (resolved.userAgent.trim().length === 0 || resolved.userAgent.length > 512 || /[\r\n]/.test(resolved.userAgent)) throw new Error("pharma-product-facts: userAgent must be 1-512 characters without line breaks");
	return Object.freeze(resolved);
}
//#endregion
//#region src/source.ts
/** Restricted official-source retrieval and request-scoped evidence storage. */
const TRUSTED_REGULATOR_DOMAINS = ["cde.org.cn", "nmpa.gov.cn"];
const EVIDENCE_ID_PATTERN = /^ev-[a-f0-9]{24}$/;
/** Bounded per-session evidence cache; source text never crosses session scopes. */
var EvidenceStore = class {
	maxScopes;
	maxRecordsPerScope;
	scopes = /* @__PURE__ */ new Map();
	/**
	* @param maxScopes - Maximum live session scopes retained by this plugin fiber.
	* @param maxRecordsPerScope - Maximum verified documents retained per scope.
	*/
	constructor(maxScopes = DEFAULT_CONFIG.maxEvidenceScopes, maxRecordsPerScope = DEFAULT_CONFIG.maxEvidenceRecordsPerScope) {
		this.maxScopes = maxScopes;
		this.maxRecordsPerScope = maxRecordsPerScope;
		if (!Number.isInteger(maxScopes) || maxScopes < 1) throw new Error("maxScopes must be a positive integer");
		if (!Number.isInteger(maxRecordsPerScope) || maxRecordsPerScope < 1) throw new Error("maxRecordsPerScope must be a positive integer");
	}
	/** Store one verified document and refresh its scope's recency. */
	put(scope, record) {
		let records = this.scopes.get(scope);
		if (records === void 0) records = /* @__PURE__ */ new Map();
		else this.scopes.delete(scope);
		records.delete(record.evidenceId);
		records.set(record.evidenceId, record);
		while (records.size > this.maxRecordsPerScope) records.delete(records.keys().next().value);
		this.scopes.set(scope, records);
		while (this.scopes.size > this.maxScopes) this.scopes.delete(this.scopes.keys().next().value);
	}
	/** Resolve one evidence id inside its originating session scope. */
	get(scope, evidenceId) {
		if (!EVIDENCE_ID_PATTERN.test(evidenceId)) return void 0;
		return this.scopes.get(scope)?.get(evidenceId);
	}
	/** Drop all retained public-source text when the owning plugin fiber stops. */
	clear() {
		this.scopes.clear();
	}
};
function trustedHostname(hostname) {
	const normalized = hostname.toLowerCase();
	return TRUSTED_REGULATOR_DOMAINS.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}
/**
* Parse and enforce the source tool's fixed public-regulator URL policy.
* @param value - Model-supplied source URL discovered through DSH web search.
* @param maxUrlChars - Validated deployment URL length limit.
* @returns A normalized HTTPS URL without a fragment.
*/
function parseOfficialSourceUrl(value, maxUrlChars = DEFAULT_CONFIG.maxUrlChars) {
	if (value.length === 0 || value.length > maxUrlChars) throw new Error("URL length is outside the accepted range");
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error("source URL is invalid");
	}
	if (url.protocol !== "https:") throw new Error("source URL must use HTTPS");
	if (url.username || url.password) throw new Error("source URL must not contain credentials");
	if (url.port && url.port !== "443") throw new Error("source URL must use the default HTTPS port");
	if (!trustedHostname(url.hostname)) throw new Error("source URL is not on an allowed CDE/NMPA host");
	url.hash = "";
	return url;
}
/** Normalize public text while preserving useful paragraph boundaries. */
function normalizeSourceText(value) {
	return value.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").split("\n").map((line) => line.replace(/[\t ]+/g, " ").trim()).filter((line, index, lines) => line.length > 0 || index > 0 && lines[index - 1]?.length !== 0).join("\n").trim();
}
/** Normalize a quote and a document to the same exact-match representation. */
function normalizeForMatch(value) {
	return normalizeSourceText(value).replace(/\s+/g, " ").trim();
}
function decodedTitle(html) {
	const match = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i.exec(html);
	return match === null ? "" : normalizeForMatch(convert(match[1], { wordwrap: false }));
}
function charsetOf(contentType) {
	return /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1]?.trim() || "utf-8";
}
async function defaultPdfDecoder(value) {
	const document = await getDocumentProxy(value);
	return (await extractText(document, { mergePages: true })).text;
}
const DEFAULT_DECODERS = {
	html: (value) => convert(value, {
		wordwrap: false,
		selectors: [
			{
				selector: "script",
				format: "skip"
			},
			{
				selector: "style",
				format: "skip"
			},
			{
				selector: "noscript",
				format: "skip"
			}
		]
	}),
	pdf: defaultPdfDecoder
};
async function cancelBody(response) {
	try {
		await response.body?.cancel();
	} catch {}
}
async function readCapped(response, maxResponseBytes) {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxResponseBytes) {
		await cancelBody(response);
		return;
	}
	if (response.body === null) return /* @__PURE__ */ new Uint8Array();
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	for (;;) {
		const part = await reader.read();
		if (part.done) break;
		size += part.value.byteLength;
		if (size > maxResponseBytes) {
			await reader.cancel();
			return;
		}
		chunks.push(part.value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
function mediaTypeOf(contentType, bytes) {
	const normalized = contentType.toLowerCase();
	const magic = new TextDecoder("ascii").decode(bytes.subarray(0, 16)).trimStart().toLowerCase();
	if (normalized.includes("application/pdf") || magic.startsWith("%pdf-")) return "pdf";
	if (normalized.includes("text/html") || normalized.includes("application/xhtml+xml") || magic.startsWith("<!doctype") || magic.startsWith("<html")) return "html";
	if (normalized.startsWith("text/") || normalized.includes("application/json") || normalized.includes("application/xml")) return "text";
}
function fallbackTitle(url) {
	return normalizeForMatch(decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) || url.hostname));
}
function evidenceIdOf(url, product, searchableText) {
	return `ev-${createHash("sha256").update(url).update("\0").update(product).update("\0").update(searchableText).digest("hex").slice(0, 24)}`;
}
function rejected(url, reason) {
	return {
		status: "rejected",
		url,
		reason
	};
}
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
async function retrieveOfficialSource(input, signal, fetchSource = globalThis.fetch, decoders = DEFAULT_DECODERS, now = /* @__PURE__ */ new Date(), limits = DEFAULT_CONFIG) {
	let current;
	try {
		current = parseOfficialSourceUrl(input.url, limits.maxUrlChars);
	} catch (error) {
		return { result: rejected(input.url, error.message) };
	}
	const product = normalizeForMatch(input.product);
	if (product.length === 0 || product.length > 100) return { result: rejected(current.toString(), "product identity is empty or too long") };
	const timeout = AbortSignal.timeout(limits.fetchTimeoutMs);
	const combined = AbortSignal.any([signal, timeout]);
	let response;
	for (let redirects = 0; redirects <= limits.maxRedirects; redirects++) {
		response = await fetchSource(current, {
			method: "GET",
			redirect: "manual",
			headers: {
				accept: "text/html,application/xhtml+xml,application/pdf,text/plain,application/json;q=0.8",
				"user-agent": limits.userAgent
			},
			signal: combined
		});
		if (![
			301,
			302,
			303,
			307,
			308
		].includes(response.status)) break;
		if (redirects === limits.maxRedirects) {
			await cancelBody(response);
			return { result: rejected(current.toString(), `source exceeded ${limits.maxRedirects} redirects`) };
		}
		const location = response.headers.get("location");
		if (location === null) {
			await cancelBody(response);
			return { result: rejected(current.toString(), "redirect response has no Location header") };
		}
		let target;
		try {
			target = parseOfficialSourceUrl(new URL(location, current).toString(), limits.maxUrlChars);
		} catch (error) {
			await cancelBody(response);
			return { result: rejected(current.toString(), error.message) };
		}
		if (target.origin !== current.origin) {
			await cancelBody(response);
			return { result: rejected(current.toString(), "cross-origin redirects are not followed") };
		}
		await cancelBody(response);
		current = target;
	}
	if (!response.ok) {
		await cancelBody(response);
		return { result: rejected(current.toString(), `official source returned HTTP ${response.status}`) };
	}
	const bytes = await readCapped(response, limits.maxResponseBytes);
	if (bytes === void 0) return { result: rejected(current.toString(), `official source exceeds the ${limits.maxResponseBytes}-byte limit`) };
	const contentType = response.headers.get("content-type") || "";
	const mediaType = mediaTypeOf(contentType, bytes);
	if (mediaType === void 0) return { result: rejected(current.toString(), "official source is not HTML, text, JSON, XML, or PDF") };
	let decoded;
	let title = "";
	try {
		if (mediaType === "pdf") decoded = await decoders.pdf(bytes);
		else {
			const sourceText = new TextDecoder(charsetOf(contentType), { fatal: true }).decode(bytes);
			title = mediaType === "html" ? decodedTitle(sourceText) : "";
			decoded = mediaType === "html" ? decoders.html(sourceText) : sourceText;
		}
	} catch (error) {
		return { result: rejected(current.toString(), `official source could not be decoded: ${error instanceof Error ? error.message : "unknown decoder error"}`) };
	}
	const normalized = normalizeSourceText(decoded);
	const searchable = normalizeForMatch(normalized);
	if (searchable.length === 0) return { result: rejected(current.toString(), "official source contains no extractable text") };
	if (!searchable.toLocaleLowerCase("zh-CN").includes(product.toLocaleLowerCase("zh-CN"))) return { result: rejected(current.toString(), `official source does not contain the requested product identity “${product}”`) };
	const truncated = normalized.length > limits.maxSourceChars;
	const text = truncated ? normalized.slice(0, limits.maxSourceChars) : normalized;
	const recordSearchable = normalizeForMatch(text);
	const url = current.toString();
	const evidenceId = evidenceIdOf(url, product, searchable);
	const record = {
		evidenceId,
		product,
		url,
		title: title || fallbackTitle(current),
		mediaType,
		text,
		searchableText: recordSearchable,
		retrievedDate: now.toISOString().slice(0, 10),
		truncated
	};
	return {
		record,
		result: {
			status: "verified",
			evidence_id: evidenceId,
			url: record.url,
			title: record.title,
			media_type: record.mediaType,
			text: record.text,
			retrieved_date: record.retrievedDate,
			truncated: record.truncated
		}
	};
}
//#endregion
//#region src/answer.ts
const DEFAULT_FAILURE_LINES = ["当前信息不足以安全完成这项核验，暂不把未核实内容作为确定事实。", "请补充明确的产品名称，或提供可公开核验的 CDE/NMPA 来源后继续。"];
const FORBIDDEN_MARKERS = [
	"HERMES_HOME",
	".hermes",
	"workspace",
	".env",
	"auth.json",
	"job.json",
	"fetch_facts.py",
	"finalize_public_answer.py",
	"render_public_answer.py",
	"validate_public_answer.py",
	"web_search",
	"pharma_product_facts_fetch_source",
	"pharma_product_facts_finalize",
	"skill_view",
	"skill_manage",
	"terminal",
	"request-id",
	"request_id",
	"job-id",
	"job_id",
	"API key",
	"Authorization",
	"Bearer ",
	"WISEDIAG_API_KEY",
	"canonical",
	"finalizer",
	"校验已通过",
	"逐字交付"
];
const PROCESS_PATTERNS = [/我(?:调用|运行|执行|读取|检查)了?(?:工具|命令|脚本|文件|配置)/i, /(?:tool|command|script) (?:call|execution|result)/i];
function line(value) {
	return normalizeForMatch(value);
}
function requiredLine(value, name, maxChars) {
	const normalized = line(value || "");
	if (normalized.length === 0) throw new Error(`${name} is required`);
	if (normalized.length > maxChars) throw new Error(`${name} exceeds ${maxChars} characters`);
	return normalized;
}
function evidenceFor(store, scope, evidenceId, product, quote) {
	const record = store.get(scope, evidenceId);
	if (record === void 0) throw new Error(`evidence_id is unknown in this session: ${evidenceId}`);
	if (record.product !== product) throw new Error("evidence product does not match the requested product");
	const normalizedQuote = requiredLine(quote, "quote", 4e3);
	if (normalizedQuote.length < 4) throw new Error("quote must contain at least 4 characters");
	if (!record.searchableText.includes(normalizedQuote)) throw new Error("quote is not an exact passage from the fetched official source");
	return {
		record,
		quote: normalizedQuote
	};
}
function sourceAuthority(record) {
	const hostname = new URL(record.url).hostname.toLowerCase();
	return hostname === "cde.org.cn" || hostname.endsWith(".cde.org.cn") ? "CDE" : "NMPA";
}
function sourceLine(record) {
	return `来源：${sourceAuthority(record)}｜${record.title}｜${record.url}｜访问日期 ${record.retrievedDate}`;
}
function uniqueRecords(records) {
	const seen = /* @__PURE__ */ new Set();
	return records.filter((record) => {
		if (seen.has(record.evidenceId)) return false;
		seen.add(record.evidenceId);
		return true;
	});
}
function scanPublicAnswer(answer) {
	if (answer.length > 8e3) throw new Error("public answer exceeds 8000 characters");
	for (const marker of FORBIDDEN_MARKERS) if (answer.toLowerCase().includes(marker.toLowerCase())) throw new Error(`public answer contains forbidden internal marker: ${marker}`);
	for (const pattern of PROCESS_PATTERNS) if (pattern.test(answer)) throw new Error("public answer narrates internal execution");
	const withoutUrls = answer.replace(/https:\/\/[^\s)]+/gi, "<PUBLIC_URL>");
	if ([
		/(?:^|[\s(])\/(?:cfs|home|tmp|var|Users)\/[^\s)]*/im,
		/[A-Za-z]:\\[^\s]+/,
		/\\\\[^\s]+/,
		/file:\/\/[^\s]+/i,
		/~[/\\][^\s]+/
	].some((pattern) => pattern.test(withoutUrls))) throw new Error("public answer contains a local path");
	if (/\bsk-[A-Za-z0-9_-]{12,}\b/.test(withoutUrls) || /\b[0-9a-fA-F]{40,}\b/.test(withoutUrls)) throw new Error("public answer contains a secret-like value");
}
function failureAnswer(input) {
	const supplied = (input.failure_message || []).map(line).filter(Boolean);
	const answer = `${(supplied.length >= 2 && supplied.length <= 4 ? supplied : [...DEFAULT_FAILURE_LINES]).join("\n")}\n`;
	scanPublicAnswer(answer);
	return {
		mode: "boundary_or_failure",
		answer,
		source_urls: []
	};
}
function identity(input) {
	const product = requiredLine(input.product, "product", 100);
	const title = requiredLine(input.title || product, "title", 160);
	if (!title.includes(product)) throw new Error("title must contain the requested product identity");
	return {
		product,
		title
	};
}
function factRows(input, store, scope, product) {
	const facts = input.facts || [];
	const limit = input.mode === "direct_field" ? 2 : input.mode === "expanded_label" ? 12 : 6;
	if (facts.length === 0) throw new Error(`${input.mode} requires at least one fact`);
	if (facts.length > limit) throw new Error(`${input.mode} exceeds its ${limit}-fact budget`);
	const records = [];
	return {
		lines: facts.map((fact, index) => {
			const field = requiredLine(fact.field, `facts[${index}].field`, 40);
			const verified = evidenceFor(store, scope, fact.evidence_id, product, fact.quote);
			records.push(verified.record);
			return `${field}：${verified.quote}`;
		}),
		records
	};
}
function unsupportedTokens(text, quote) {
	const tokens = [...text.match(/\d+(?:[.,]\d+)?%?/g) || [], ...text.match(/\b[A-Z][A-Z0-9-]{1,}\b/g) || []];
	return [...new Set(tokens)].filter((token) => !quote.toLowerCase().includes(token.toLowerCase()));
}
function focusRows(input, store, scope, product) {
	const focus = input.clinical_focus || [];
	if (focus.length < 3 || focus.length > 5) throw new Error("hcp_focus_card requires 3-5 clinical_focus items");
	const records = [];
	const lines = focus.map((item, index) => {
		const text = requiredLine(item.text, `clinical_focus[${index}].text`, 180);
		const verified = evidenceFor(store, scope, item.evidence_id, product, item.quote);
		const unsupported = unsupportedTokens(text, verified.quote);
		if (unsupported.length > 0) throw new Error(`clinical_focus[${index}] introduces unsupported token: ${unsupported.join(", ")}`);
		records.push(verified.record);
		return text;
	});
	if (lines.join("").length > 400) throw new Error("hcp_focus_card exceeds its 400-character budget");
	return {
		lines,
		records
	};
}
function renderSources(records) {
	const unique = uniqueRecords(records);
	return {
		lines: unique.map(sourceLine),
		urls: unique.map((record) => record.url)
	};
}
function standardAnswer(input, store, scope) {
	if ((input.clinical_focus || []).length > 0 || input.label_boundary !== void 0) throw new Error(`${input.mode} accepts facts only`);
	const { product, title } = identity(input);
	const facts = factRows(input, store, scope, product);
	const sources = renderSources(facts.records);
	const lines = [title, ""];
	if (input.mode !== "direct_field") lines.push("说明书事实");
	lines.push(...facts.lines.map((value) => `- ${value}`), "", ...sources.lines);
	if (input.mode !== "direct_field") lines.push("仅供 HCP 参考；个体化用药以核准说明书及医师/药师判断为准。");
	const answer = `${lines.join("\n").trim()}\n`;
	scanPublicAnswer(answer);
	return {
		mode: input.mode,
		answer,
		source_urls: sources.urls
	};
}
function hcpFocusAnswer(input, store, scope) {
	const { product, title } = identity(input);
	if ((input.facts || []).length > 0 || input.label_boundary !== void 0) throw new Error("hcp_focus_card accepts clinical_focus only");
	const focus = focusRows(input, store, scope, product);
	const sources = renderSources(focus.records);
	const answer = `${[
		title,
		"",
		"临床关注（说明书衍生，非个体化）",
		...focus.lines.map((value) => `- ${value}`),
		"",
		...sources.lines,
		"仅供 HCP 参考；个体化用药以核准说明书及医师/药师判断为准。"
	].join("\n").trim()}\n`;
	scanPublicAnswer(answer);
	return {
		mode: "hcp_focus_card",
		answer,
		source_urls: sources.urls
	};
}
function labelBoundaryAnswer(input, store, scope) {
	const { product } = identity(input);
	if ((input.facts || []).length > 0 || (input.clinical_focus || []).length > 0) throw new Error("label_boundary accepts only label_boundary evidence");
	const boundary = input.label_boundary;
	if (boundary === void 0) throw new Error("label_boundary is required");
	const questionedUse = requiredLine(boundary.questioned_use, "label_boundary.questioned_use", 100);
	const verified = evidenceFor(store, scope, boundary.evidence_id, product, boundary.scope_quote);
	const questionedUsePresent = verified.record.searchableText.includes(questionedUse);
	if (boundary.approval_status === "listed" && !questionedUsePresent) throw new Error("listed use is not present in the fetched official source");
	if (boundary.approval_status === "not_listed") {
		if (verified.record.truncated) throw new Error("absence cannot be established from a truncated source");
		if (questionedUsePresent) throw new Error("not_listed use is present in the fetched official source");
	}
	const conclusion = boundary.approval_status === "listed" ? `${product}当前说明书已载明「${questionedUse}」。` : `${product}当前说明书未载明「${questionedUse}」。`;
	const wording = boundary.approval_status === "listed" ? `可表述为：${product}核准说明书载明「${questionedUse}」；具体适用范围以说明书原文为准。` : `不应把「${questionedUse}」表述为已获批用途；可仅复述当前核准范围。`;
	const sources = renderSources([verified.record]);
	const answer = `${[
		`核对结论：${conclusion}`,
		`当前核准范围：${verified.quote}`,
		`建议表述：${wording}`,
		"",
		...sources.lines
	].join("\n").trim()}\n`;
	scanPublicAnswer(answer);
	return {
		mode: "label_boundary",
		answer,
		source_urls: sources.urls
	};
}
/**
* Validate evidence relationships and render one canonical public answer.
* @param input - Structured finalizer arguments supplied by the model.
* @param store - Plugin-owned evidence store.
* @param scope - Current DSH agent/session scope.
* @returns Canonical answer and its derived source URLs.
*/
function finalizeAnswer(input, store, scope) {
	if (input.mode === "boundary_or_failure") return failureAnswer(input);
	if (input.mode === "hcp_focus_card") return hcpFocusAnswer(input, store, scope);
	if (input.mode === "label_boundary") return labelBoundaryAnswer(input, store, scope);
	return standardAnswer(input, store, scope);
}
//#endregion
//#region src/tools.ts
/** Model-visible restricted retrieval tool. */
const FETCH_SOURCE_TOOL = "pharma_product_facts_fetch_source";
/** Model-visible deterministic answer finalizer. */
const FINALIZE_TOOL = "pharma_product_facts_finalize";
/** Derive the evidence isolation key from the current DSH agent. */
function evidenceScope(agentId) {
	return agentId === void 0 ? "<unscoped>" : String(agentId);
}
const factSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		field: {
			type: "string",
			required: true,
			description: "Short label field, such as 适应症 or 规格."
		},
		quote: {
			type: "string",
			required: true,
			description: "Exact quotation copied from fetched source text."
		},
		evidence_id: {
			type: "string",
			required: true,
			description: "Evidence id returned by the source tool in this session."
		}
	}
};
const focusSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		text: {
			type: "string",
			required: true,
			description: "Concise non-individualized HCP focus statement."
		},
		quote: {
			type: "string",
			required: true,
			description: "Exact supporting quotation from fetched source text."
		},
		evidence_id: {
			type: "string",
			required: true,
			description: "Evidence id returned by the source tool in this session."
		}
	}
};
const boundarySchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		questioned_use: {
			type: "string",
			required: true,
			description: "The exact proposed use being checked."
		},
		approval_status: {
			type: "string",
			enum: ["listed", "not_listed"],
			required: true,
			description: "Whether the exact proposed use appears in the complete fetched source."
		},
		scope_quote: {
			type: "string",
			required: true,
			description: "Exact quotation of the current approved scope."
		},
		evidence_id: {
			type: "string",
			required: true,
			description: "Evidence id returned by the source tool in this session."
		}
	}
};
/**
* Register both DSH-native tools against one request-scoped evidence store.
* @param ctx - Cordis context carrying the DSH tool registry.
* @param config - Complete transport, timeout, and evidence-cache settings.
* @param options - Optional deterministic transport overrides for tests.
* @returns The store owned by this plugin fiber.
*/
function registerPharmaProductFactsTools(ctx, config, options = {}) {
	const store = new EvidenceStore(config.maxEvidenceScopes, config.maxEvidenceRecordsPerScope);
	const now = options.now || (() => /* @__PURE__ */ new Date());
	ctx.tools.register(defineTool({
		name: FETCH_SOURCE_TOOL,
		description: "Fetch and extract one public CDE/NMPA HTML, text, JSON, XML, or PDF source. Only official HTTPS regulator hosts are allowed, and the requested product name must occur in the extracted text.",
		parameters: {
			url: {
				type: "string",
				required: true,
				description: "Official CDE/NMPA URL discovered with web_search."
			},
			product: {
				type: "string",
				required: true,
				description: "Exact product identity from the user request."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					status: {
						type: "string",
						enum: ["verified", "rejected"],
						required: true
					},
					url: {
						type: "string",
						required: true
					},
					reason: { type: "string" },
					evidence_id: { type: "string" },
					title: { type: "string" },
					media_type: {
						type: "string",
						enum: [
							"html",
							"pdf",
							"text"
						]
					},
					text: { type: "string" },
					retrieved_date: { type: "string" },
					truncated: { type: "boolean" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.status === "verified" ? [
					`Verified official source: ${value.title || value.url}`,
					`evidence_id: ${value.evidence_id || ""}`,
					`retrieved_date: ${value.retrieved_date || ""}`,
					value.truncated ? "Notice: extracted text was truncated; do not infer absence from it." : "",
					"",
					value.text || ""
				].filter((part, index) => part.length > 0 || index === 4).join("\n") : `Rejected official source: ${value.reason || "source did not pass validation"}\nURL: ${value.url}`
			}]
		},
		timeoutMs: config.sourceToolTimeoutMs,
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const resolved = await retrieveOfficialSource(args, exec.signal, options.fetchSource, options.decoders, now(), config);
			if (resolved.record !== void 0) store.put(evidenceScope(exec.agent?.id), resolved.record);
			return resolved.result;
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Verify official source for ${args.product}`,
			kind: "search",
			rawInput: args.url
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: result.isError ? "Official source verification failed" : "Official source verification complete",
			content: result.content
		})
	}));
	ctx.tools.register(defineTool({
		name: FINALIZE_TOOL,
		description: "Validate exact quotations against official evidence fetched in this DSH session and render the canonical public pharma-product-facts answer. Call this last and copy its answer exactly.",
		parameters: {
			mode: {
				type: "string",
				enum: [
					"direct_field",
					"product_card",
					"hcp_focus_card",
					"label_boundary",
					"expanded_label",
					"boundary_or_failure"
				],
				required: true
			},
			product: { type: "string" },
			title: { type: "string" },
			facts: {
				type: "array",
				items: factSchema
			},
			clinical_focus: {
				type: "array",
				items: focusSchema
			},
			label_boundary: boundarySchema,
			failure_message: {
				type: "array",
				items: { type: "string" }
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					mode: {
						type: "string",
						enum: [
							"direct_field",
							"product_card",
							"hcp_focus_card",
							"label_boundary",
							"expanded_label",
							"boundary_or_failure"
						],
						required: true
					},
					answer: {
						type: "string",
						required: true
					},
					source_urls: {
						type: "array",
						items: { type: "string" },
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.answer
			}]
		},
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			return finalizeAnswer(args, store, evidenceScope(exec.agent?.id));
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Finalize pharma facts: ${args.product || args.mode}`,
			kind: "read"
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: result.isError ? "Pharma facts validation failed" : "Pharma facts answer",
			content: result.content
		})
	}));
	ctx.effect(() => () => {
		store.clear();
	}, "pharma-product-facts: clear session evidence");
	return store;
}
//#endregion
//#region src/index.ts
/**
* Bundled pharma-product-facts provider and soft router.
*
* @module dsh-pharma-product-facts
*/
const PROVIDER_NAME = "pharma-product-facts";
const SKILL_BODY_URL = new URL("../assets/pharma-product-facts/SKILL.md", import.meta.url);
const RESOURCE_BASE = {
	kind: "directory",
	path: fileURLToPath(new URL("../assets/pharma-product-facts/", import.meta.url))
};
const INVOCATION = {
	modelInvocable: true,
	userInvocable: true
};
const DESCRIPTION = "查询处方药获批事实，并以公开原始来源给出可追溯回答。";
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const CANDIDATE = {
	name: "pharma-product-facts",
	description: DESCRIPTION,
	invocation: INVOCATION,
	provider: PROVIDER_NAME,
	source: "bundled",
	resourceBase: RESOURCE_BASE,
	rank: BUNDLED_SKILL_RANK,
	locator: SKILL_BODY_URL
};
const provider = {
	name: PROVIDER_NAME,
	list: () => Promise.resolve([CANDIDATE]),
	async get(_candidate) {
		const content = (await readFile(SKILL_BODY_URL, "utf8")).replace(FRONTMATTER, "").trim();
		return {
			name: CANDIDATE.name,
			description: CANDIDATE.description,
			invocation: CANDIDATE.invocation,
			provider: CANDIDATE.provider,
			source: CANDIDATE.source,
			resourceBase: RESOURCE_BASE,
			content
		};
	}
};
/** Cordis plugin name and bundle row id. */
const name = "pharma-product-facts";
/** Services required by the provider, native tools, and pre-step router. */
const inject = [
	"skills",
	"agents",
	"tools"
];
/**
* Register the immutable provider, DSH-native tools, and soft router in one plugin fiber.
* @param ctx - Cordis context carrying the skill, agent, and tool services.
* @param config - Validated transport and evidence limits for this row.
*/
function apply(ctx, config = {}) {
	const resolved = resolveConfig(config);
	ctx.skills.registerProvider(() => provider);
	registerPharmaProductFactsTools(ctx, resolved);
	registerPharmaProductFactsRouter(ctx);
}
//#endregion
export { Config, DEFAULT_CONFIG, apply, inject, name, resolveConfig };
