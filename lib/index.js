import { r as registerPharmaProductFactsRouter } from "./router-DW9bEapZ.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BUNDLED_SKILL_RANK } from "@deepseek-ai/dsh-skill";
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
/** Services required by the provider and pre-step router. */
const inject = ["skills", "agents"];
/**
* Register the immutable provider and soft router in one plugin fiber.
* @param ctx - Cordis context carrying the skill and agent services.
*/
function apply(ctx) {
	ctx.skills.registerProvider(() => provider);
	registerPharmaProductFactsRouter(ctx);
}
//#endregion
export { apply, inject, name };
