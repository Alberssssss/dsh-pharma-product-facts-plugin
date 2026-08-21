import { t as ROUTER_HINT } from "./router-DW9bEapZ.js";
//#region src/invariant.ts
const PACKAGE_NAME = "dsh-pharma-product-facts";
/** Cordis companion plugin name. */
const name = "pharma-product-facts-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
function validateEvent(event, fail) {
	if (event.type !== "user/message" || event.data.source.kind !== "plugin" || event.data.source.plugin !== "pharma-product-facts") return;
	const source = event.data.source;
	const blockValue = event.data.content[0];
	const block = typeof blockValue === "object" && blockValue !== null ? blockValue : void 0;
	if (Object.keys(source).length !== 3 || source.form !== "instructions") fail("router messages must retain only the package instructions source");
	if (event.data.content.length !== 1 || block === void 0 || Object.keys(block).length !== 2 || block.type !== "text" || block.text !== ROUTER_HINT) fail("router messages must retain the exact packaged soft-route instructions");
}
function validateSession(session, fail) {
	for (const event of session.events) validateEvent(event, fail);
}
const install = Object.assign((ctx, fail) => {
	for (const session of ctx.sessions.list()) validateSession(session, fail);
	ctx.on("session/created", (session) => {
		validateSession(session, fail);
	}, { global: true });
	ctx.on("internal/dispatch", (_mode, eventName, args) => {
		if (eventName !== "session/event") return;
		const [, event] = args;
		validateEvent(event, fail);
	});
}, { inject: ["sessions"] });
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
