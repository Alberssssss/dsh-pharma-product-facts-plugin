import { createUserMessage } from "@deepseek-ai/dsh-llm";
//#region src/router.ts
/** Source owner recorded on durable router instructions. */
const ROUTER_SOURCE = "pharma-product-facts";
/** Stable model-visible reminder emitted for a matching user request. */
const ROUTER_HINT = [
	"<pharma-product-facts-router>",
	"这是软路由提示，不表示 skill 已加载。本轮用户请求可能属于获批产品身份、静态说明书事实或非个体化 HCP 关注卡。采取任务动作前，先调用 `skill` 工具并使用精确名称 `pharma-product-facts` 加载完整说明；只有加载后的说明才是执行依据。若主意图是个体患者用药、剂量计算、给药操作、不良反应处置、联用、竞品比较、销售推广、推广性超说明书请求、注册元数据/说明书下载或证据综述，不要套用此 skill，按主意图处理。",
	"</pharma-product-facts-router>"
].join("\n");
const PRODUCT_ENTITIES = [
	"德瑞妥",
	"得佑",
	"天韵",
	"甘美",
	"甘平",
	"贝乐林",
	"妥洛特罗",
	"利拉鲁肽",
	"利拉鲁泰",
	"链霉蛋白酶",
	"异甘草酸镁",
	"甘草酸二铵",
	"甘草酸二胺",
	"多黏菌素",
	"多粘菌素"
];
const LABEL_FACT_TERMS = [
	"适应症",
	"适应证",
	"规格",
	"剂型",
	"成分",
	"辅料",
	"储存",
	"贮藏",
	"有效期",
	"半衰期",
	"达峰时间",
	"药代动力学",
	"作用机制",
	"作用机理",
	"药理作用",
	"用法用量",
	"说明书上",
	"说明书里",
	"说明书怎么",
	"说明书是怎么"
];
const PRODUCT_SCOPED_TERMS = [
	"是否获批",
	"获批用于",
	"获批适应症",
	"获批适应证",
	"超说明书",
	"超适应症",
	"不良反应",
	"禁忌",
	"慎用",
	"警示",
	"注意事项",
	"特殊人群",
	"妊娠",
	"哺乳",
	"孕妇",
	"孕产妇",
	"儿童",
	"老年"
];
const HCP_FOCUS_INTENTS = [
	"医生在临床使用中主要关注",
	"医生主要关注哪些关键问题",
	"医生关注的关键问题",
	"处方时的医生考量因素",
	"处方时医生考量因素",
	"处方时医生需要考虑",
	"医生处方考量",
	"临床应用要点"
];
const CLINICAL_EXCLUSIONS = [
	"这个患者",
	"该患者",
	"患者用了",
	"患者使用",
	"患者用药",
	"我的情况",
	"本人",
	"我正在吃",
	"我在吃",
	"我正在用",
	"我在用",
	"我准备吃",
	"我准备用",
	"按体重",
	"按肌酐",
	"肌酐清除率",
	"egfr",
	"crcl",
	"bsa",
	"剂量计算",
	"剂量调整",
	"减量",
	"调量",
	"配液",
	"复溶",
	"稀释",
	"雾化",
	"贴敷",
	"漏服",
	"漏打",
	"补打",
	"漏用",
	"漏吃",
	"不良反应怎么",
	"副作用怎么办",
	"怎么处置",
	"如何处置",
	"处理不良反应",
	"用药后出现",
	"使用后出现",
	"联用",
	"联合用药",
	"配伍",
	"相互作用",
	"肝功能不全",
	"肾功能不全",
	"肝肾功能不全"
];
const COMPARISON_EXCLUSIONS = [
	"竞品",
	"原研",
	"同类",
	"头对头",
	"head-to-head",
	"对比",
	"相比",
	"相较",
	"优劣",
	"谁更好",
	"哪家好",
	"差异化"
];
const COMMERCIAL_EXCLUSIONS = [
	"推广",
	"卖点",
	"fabe",
	"话术",
	"销售",
	"物料",
	"邀请函",
	"拜访",
	"处方率",
	"处方量",
	"提单",
	"上量",
	"让医生开",
	"让他开"
];
const METADATA_EXCLUSIONS = [
	"受理号",
	"批准文号",
	"注册分类",
	"生产企业",
	"生产厂家",
	"持有人",
	"下载说明书",
	"爬说明书",
	"抓取说明书",
	"说明书 pdf"
];
const EVIDENCE_EXCLUSIONS = [
	"pmid",
	"doi",
	"rct",
	"文献",
	"论文",
	"研究证据",
	"临床研究",
	"临床试验",
	"系统综述",
	"系统评价",
	"meta分析",
	"荟萃分析",
	"指南",
	"共识",
	"循证"
];
const PATIENT_PARAMETER = /\d+(?:\.\d+)?\s*(?:岁|kg|公斤|mmol|μmol|umol)(?:\s|$|[、，。！？,.!?])/i;
function includesAny(text, terms) {
	return terms.some((term) => text.includes(term));
}
function hasExcludedIntent(text) {
	return PATIENT_PARAMETER.test(text) || includesAny(text, CLINICAL_EXCLUSIONS) || includesAny(text, COMPARISON_EXCLUSIONS) || includesAny(text, COMMERCIAL_EXCLUSIONS) || includesAny(text, METADATA_EXCLUSIONS) || includesAny(text, EVIDENCE_EXCLUSIONS);
}
/**
* Decide whether one user-authored text matches the packaged skill's narrow domain.
* @param value - user-authored text from the claimed pre-step batch.
* @returns whether the soft router should recommend loading the skill.
*/
function matchesPharmaProductFacts(value) {
	const text = value.trim().toLowerCase();
	if (text.length === 0 || hasExcludedIntent(text)) return false;
	const hasProduct = includesAny(text, PRODUCT_ENTITIES);
	if (hasProduct && includesAny(text, HCP_FOCUS_INTENTS)) return true;
	if (includesAny(text, LABEL_FACT_TERMS)) return true;
	return hasProduct && includesAny(text, PRODUCT_SCOPED_TERMS);
}
function textOf(message) {
	return message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}
/**
* Match only user-authored text messages from one claimed pre-step batch.
* @param messages - exclusive claimed messages offered to the waterfall.
* @returns whether any authentic user message matches the route.
*/
function matchesPharmaProductFactsMessages(messages) {
	return messages.some((message) => message.source.kind === "user" && matchesPharmaProductFacts(textOf(message)));
}
/**
* Register the waterfall listener that appends the soft route after downstream acceptance.
* @param ctx - plugin context carrying the agent event service.
*/
function registerPharmaProductFactsRouter(ctx) {
	ctx.on("agent/pre-step", async ({ messages, signal }, next) => {
		const matched = matchesPharmaProductFactsMessages(messages);
		const decision = await next();
		if (!matched || decision.kind === "reject" || signal.aborted) return decision;
		return {
			kind: "enter",
			messages: [...decision.messages, createUserMessage({
				content: [{
					type: "text",
					text: ROUTER_HINT
				}],
				source: {
					kind: "plugin",
					plugin: ROUTER_SOURCE,
					form: "instructions"
				}
			})]
		};
	});
}
//#endregion
export { ROUTER_SOURCE as n, registerPharmaProductFactsRouter as r, ROUTER_HINT as t };
