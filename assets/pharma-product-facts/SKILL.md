---
name: pharma-product-facts
description: 查询处方药获批事实，并以公开原始来源给出可追溯回答。
license: MIT
metadata:
  dsh:
    tags: [health, pharma, product-facts, hcp]
    aliases: ["/药品事实", "/product-facts"]
---

# 处方药产品事实 Skill

面向医药代表、市场部和 MSL，核对具名处方药的适应症、用法用量原文、规格、成分、剂型、储存、机制、药代及静态安全标签。只回答用户需要的字段，不扩写推广方案，也不代替医生进行个体化用药判断。

## 适用范围

- 具名产品的中国获批说明书事实、产品身份或核准用途边界。
- 说明书中的不良反应、禁忌、警示及特殊人群静态原文。
- 不带患者参数的 HCP 关注点；每条关注点仍须绑定说明书原文。
- 不用于个体调量、联用、漏服、给药操作、不良反应处置、竞品优劣、价格准入、购买推荐、销售推广或文献综述。

## DSH 原生工作流

本包已经注册两个专用工具：

- `pharma_product_facts_fetch_source`：只读取公开的 CDE/NMPA HTTPS 页面或 PDF，抽取正文并核对用户给出的产品名。
- `pharma_product_facts_finalize`：把精确原文与本会话取得的 evidence id 重新绑定，执行来源、隔离、长度及内部信息检查，并生成唯一公开答案。

不要使用文件搜索、文件读取、shell、Python 或其他本地 skill 完成本流程。不要扫描用户主目录或任何历史工作区。PDF 由专用来源工具直接解析。

按以下顺序执行：

1. 识别产品、地区和被问字段。产品名不清且会改变答案时，先澄清。
2. 使用 DSH 的 `web_search` 搜索当前产品与目标字段，查询优先包含 `site:cde.org.cn` 或 `site:nmpa.gov.cn`。名称候选只用于扩展查询，不能作为事实来源。
3. 搜索摘要只用于发现 URL，不能直接支撑标签事实。对候选官方 URL 调用：

   ```json
   {
     "url": "https://www.cde.org.cn/...",
     "product": "贝乐林"
   }
   ```

   工具返回 `status: "verified"` 后，才可使用其中的 `evidence_id` 与正文。若返回 `rejected`，换另一条真实官方 URL；不要改用聚合站、模型记忆或本地文件。
4. 从已验证正文复制支持目标字段的最小精确原文。不要补写正文中没有的剂量、数字、适用人群或身份关系。一旦已有来源覆盖全部目标字段，立即停止继续搜索或抓取。
5. 选择输出模式并调用 `pharma_product_facts_finalize`。每次只提交该模式使用的字段，其他模式字段必须省略，不能传空数组或多余对象。该调用必须是本轮最后一个业务动作。
6. finalizer 成功后，最终 assistant 内容必须逐字等于返回对象的 `answer`，不得添加前言、结论、Markdown 包裹、验收状态或第二版答案。

如果 finalizer 只报告模式字段错误，最多立即纠正参数并重试 finalizer 一次；必须复用已有 evidence，不得再次调用 `web_search` 或来源工具。纠正后仍失败时停止工具调用，不进入循环重试。

## 来源与身份规则

1. 标签事实只接受专用来源工具验证过的 CDE/NMPA 原文；普通搜索结果、新闻、第三方数据库和模型记忆均不能替代。
2. 来源正文必须出现用户请求中的确切产品名；同成分其他品牌、剂型或国家标签不得静默继承。
3. 数字、剂量、比例、日期及“首个/唯一”等主张只能出现在精确引用中。无法取得直接原文时不写。
4. `status: "verified"` 只表示 URL、来源域、文本抽取和产品名检查通过，不表示任意模型总结自动成立；finalizer 仍要求逐条精确引用。
5. 来源文本被标记为 `truncated: true` 时，可以引用已返回的原文，但不能据此断言某用途“未载明”。
6. `references/product-name-map.md` 只提供搜索候选，不支持任何说明书事实。

## 输出模式

完整参数示例见 `references/answer-contract.md`。

### `direct_field`

用于一个或两个说明书字段。每条 `facts` 包含短字段名、精确原文及同一会话取得的 `evidence_id`：

```json
{
  "mode": "direct_field",
  "product": "贝乐林",
  "title": "贝乐林",
  "facts": [
    {
      "field": "适应症",
      "quote": "从来源工具正文逐字复制的原文",
      "evidence_id": "ev-..."
    }
  ]
}
```

最多两条事实。finalizer 从 evidence id 自动生成来源 URL 和访问日期；不要自行填写来源。

### `product_card` / `expanded_label`

产品概览用 `product_card`，最多六条事实；用户明确要求完整或详细内容时使用 `expanded_label`，最多十二条。每条仍须是精确原文。

### `hcp_focus_card`

用于无患者参数的医生关注点，必须给 3–5 条 `clinical_focus`。每条包含简洁关注点、支持它的精确原文和 evidence id。关注点中的数字与英文缩写必须原样出现在引用中。

规范调用只能包含 `mode`、`product`、`title` 和 `clinical_focus`；必须省略 `facts`、`label_boundary` 与 `failure_message`：

```json
{
  "mode": "hcp_focus_card",
  "product": "产品名",
  "title": "产品名 HCP 关注",
  "clinical_focus": [
    { "text": "关注点一", "quote": "支持关注点一的精确原文", "evidence_id": "ev-..." },
    { "text": "关注点二", "quote": "支持关注点二的精确原文", "evidence_id": "ev-..." },
    { "text": "关注点三", "quote": "支持关注点三的精确原文", "evidence_id": "ev-..." }
  ]
}
```

### `label_boundary`

用于核对具体用途是否载明：

```json
{
  "mode": "label_boundary",
  "product": "贝乐林",
  "title": "贝乐林",
  "label_boundary": {
    "questioned_use": "体重管理",
    "approval_status": "not_listed",
    "scope_quote": "当前核准适应症的精确原文",
    "evidence_id": "ev-..."
  }
}
```

- `listed` 要求被问用途确实出现在完整来源文本中。
- `not_listed` 要求被问用途未出现在完整且未截断的来源文本中。
- 建议表述由 finalizer 确定性生成，不自行扩写研究结果或其他产品信息。

### `boundary_or_failure`

产品含糊、没有可验证官方来源或问题越界时，使用 2–4 行最小失败说明：

```json
{
  "mode": "boundary_or_failure",
  "failure_message": [
    "目前没有取得可公开核验且与该产品匹配的中国监管原文，暂不把相关内容写成确定事实。",
    "如能提供确切产品名或 CDE/NMPA 官方页面，可继续核对。"
  ]
}
```

失败答案不得出现工具名、路径、凭据、接口状态或内部过程。

## 安全分流

- 说明书静态用法用量、不良反应、禁忌和特殊人群原文可以回答。
- 体重/肾功能计算、个体调量、联用、漏服、AE 预防或处置属于临床决策支持，不在本 skill 中代答。
- 真实暴露后出现严重症状时优先提示及时就医或联系急救，不继续做静态事实卡。
- 超说明书问题只能核对是否载明及当前核准范围，不能提供促进处方或规避合规限制的话术。

## 公开输出红线

- 不显示工具名、命令、skill 名、内部 id 以外的实现过程、文件路径、主目录、环境变量或凭据。
- 不声称“最新版”，除非来源正文明确提供且已核对版本或更新时间。
- 不把搜索摘要、名称映射或第三方页面写成监管说明书。
- 不在 finalizer 后继续调用工具或改写它的 `answer`。
