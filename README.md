# dsh-pharma-product-facts

English | [中文](README.zh.md)

Standalone DSH bundle containing one `pharma-product-facts` skill provider, its narrow `agent/pre-step` router, and two DSH-native evidence tools. One Cordis row owns all four contributions, so installation, disablement, reload, and removal are atomic.

The runtime workflow is self-contained inside DSH. It uses the shipped `web_search` tool for URL discovery, a package-owned restricted CDE/NMPA HTML/PDF retriever, and a package-owned deterministic answer finalizer. It does not execute external medical skills, local Python scripts, or user-home resources.

## Install

In the DSH Web UI plugin field, paste only:

```text
github:Alberssssss/dsh-pharma-product-facts-plugin
```

From a terminal:

```sh
dsh plugin --profile web add github:Alberssssss/dsh-pharma-product-facts-plugin
```

Restart the `web` profile Host and create a new session. Existing sessions retain the composition and skill body with which they were created.

This repository commits verified prebuilt `lib/` files and declares no install-time scripts, so a clean DSH profile can install the Git package without a pnpm `allowBuilds` exception. Source checkouts remain independently buildable with `pnpm run build`. Pin a reviewed commit when appropriate:

```text
github:Alberssssss/dsh-pharma-product-facts-plugin#<commit>
```

DSH may report peer packages as absent from the profile directory because the Host supplies its core packages through the installation-owned module fallback. Do not install a second Cordis or DSH core copy merely to suppress that warning. Verify the resolved row with:

```sh
dsh --profile web --dump-config
```

## Model visibility

Use a preset with `@deepseek-ai/dsh-tool-skill`, such as `standard` or `code`. The shared skill tool loads this package with `skill({ name: "pharma-product-facts" })`; there is no tool named after the GitHub repository.

Loading the plugin also registers these model-visible tools:

- `pharma_product_facts_fetch_source` accepts only HTTPS URLs on CDE/NMPA hosts, follows only same-origin redirects, bounds response size and time, extracts HTML/text/PDF content, and requires the exact requested product identity to occur in the document.
- `pharma_product_facts_finalize` accepts exact quotations and same-session evidence ids, rejects cross-session or altered evidence, derives source URLs itself, and renders the canonical public answer.

The skill uses DSH `web_search` only to discover candidate official URLs. Search snippets are not accepted as label evidence. The standard DSH base profile already exposes `web_search`; its configured search provider must be usable for live discovery.

## Optional OpenAI search companion

This bundle does not package or select a web-search backend. It consumes the stable DSH `web_search` tool and works with any usable configured provider. To route that tool through OpenAI Responses native Web Search, install the companion bundle:

```sh
dsh plugin --profile web add github:Alberssssss/dsh-web-search-openai
```

The companion changes discovery only. This pharma bundle still fetches the cited CDE/NMPA page or PDF itself, checks the requested product identity and exact quotations, and owns the final answer. Installing either bundle does not force the conversation model to call the skill or `web_search`.

## Runtime safety

- Evidence is isolated by DSH agent/session and held only in a bounded in-memory store.
- The retriever sends no cookies or credentials and rejects non-regulator hosts, HTTP, embedded credentials, non-default ports, cross-origin redirects, unsupported media, oversized responses, and product-identity mismatches.
- PDF text extraction is bundled through the maintained `unpdf` dependency; no external document service is needed.
- The finalizer verifies every public quotation against fetched text and prevents a truncated document from supporting an “absence” conclusion.
- Public output rejects local paths, credential-like strings, tool names, and execution narration.

The package does not make the network or public regulator sites infallible. When no complete matching official source can be obtained, the skill returns a bounded “not verified” answer instead of filling facts from memory.

## Configuration

All deployment-varying resource limits are fields on the same plugin row. Override the bundle row by id and restate its name:

```yaml
- id: pharma-product-facts
  name: dsh-pharma-product-facts
  config:
    fetchTimeoutMs: 30000
    sourceToolTimeoutMs: 35000
    maxResponseBytes: 12000000
    maxSourceChars: 180000
```

The remaining defaults are `maxUrlChars: 4096`, `maxRedirects: 3`, `maxEvidenceScopes: 64`, and `maxEvidenceRecordsPerScope: 24`. `userAgent` is also configurable for deployments that require an operator-specific public identifier. Invalid numbers, a source-tool timeout shorter than the fetch timeout, and unsafe User-Agent text fail while the plugin loads. The HTTPS requirement and CDE/NMPA hostname allowlist are fixed security rules and cannot be relaxed through configuration.

## Routing boundary

The router recommends this skill for product identity, static label facts, label safety fields, approval boundaries, and non-individualized HCP focus cards. It excludes patient-specific dosing or administration, adverse-event management, combinations, competitor comparisons, commercial promotion, registration-document download tasks, and evidence reviews. A router hint is not proof of skill use; inspect the later `skill` call and evidence-tool calls in the session log.

## Lifecycle

Disable every contribution together:

```yaml
- id: pharma-product-facts
  disabled: true
```

Remove the installed bundle:

```sh
dsh plugin --profile web remove dsh-pharma-product-facts
```

## Development and verification

The Git repository is independent: package versions are ordinary registry ranges, there are no `workspace:` dependencies, and `pnpm run build` builds from this checkout alone. Git installs use the committed `lib/` artifacts and execute no dependency lifecycle script.

```sh
pnpm install
pnpm run typecheck
pnpm run test:coverage
pnpm run build
pnpm run pack:check
```

The package remains an external plugin rather than an official DeepSeek Harness release component. Medical correctness still depends on the exact public source selected and quoted; deterministic validation reduces source substitution and transcript leakage but does not replace clinical or regulatory review.
