---
name: pharma-product-facts
description: 查询处方药获批事实，并以公开原始来源给出可追溯回答。
version: 0.2.0
author: health-hermes-agent
license: MIT
platforms: [linux, macos, windows]
category: health
metadata:
  hermes:
    tags: [health, pharma, marketing, product-facts, hcp]
    category: health
    related_skills: [med-online-kb, pharma-competitor-analysis, pharma-clinical-use, medication-review]
    aliases: ["/药品事实", "/product-facts"]
---

# 处方药产品事实 Skill

面向医药代表、市场部和 MSL，查询适应症、用法用量原文、规格、成分、剂型、储存、机制、药代及静态安全标签等客观事实。
只回答用户需要的字段，不把事实查询扩写成完整推广方案，也不代替医生做个体化用药决策。

数字证据为最高优先级：每一行精确比例、样本量、日期、剂量和“首个/唯一”等主张，都要在本行或相邻行附直接 URL、可公开复核的 CDE acceptid、PMID 或 DOI；答案别处的无关链接及仅写作者、期刊、指南名或新闻标题不能替代。做不到就不写该数字或主张。

## §0 何时用 / 何时不用（When to Use｜适用门）

- 用户询问具名处方药的获批说明书事实或产品身份。
- 用户询问说明书列出的不良反应、禁忌/慎用、警示，或妊娠哺乳、儿童、老年等特殊人群的静态原文。
- 用户询问某个具体商品、剂型或规格是否在中国获批用于某适应症，包括肥胖/体重管理等可能超说明书的问题。
- 销售、活动或竞品任务需要核实少量产品事实时，可只返回被请求的事实与来源。
- 宽泛推广题只核实支撑核心表达所需的最少事实，不主动扩展新闻数字、患病率、药代时间或非必要研究统计。
- 不用于个体患者调量、联用、漏服、不良反应处置、特殊人群“能否用/如何调整”的临床判断、竞品优劣、价格准入或患者荐药。

> **NON-NEGOTIABLE LAST-TOOL RULE**：`finalize_public_answer.py` 退出 0 后，该 terminal 调用必须是
> 本轮最后一个工具动作；最终 assistant 内容必须逐字等于 stdout。禁止加一句结论、前言、补充说明、
> Markdown 包裹或验收状态，即使你认为它们更有帮助。最终消息中尤其禁止出现“finalizer 退出 0”、
> “以下为逐字交付”“canonical 答案”“校验已通过”等元话语；直接从 stdout 首字开始回答。

## Prerequisites

- 从已加载的 `<skill_resources>` 读取 `Base directory for this skill`；下文用 `<skill-dir>` 指代该绝对目录，运行包内脚本前必须替换成真实目录。
- 包内只提供本 skill 的指令、引用资料和确定性脚本；运行检索与解析仍依赖外部 `HERMES_HOME`、`med-online-kb` 和 `document-parser` 部署。
- 包内 `scripts/fetch_facts.py` 是 DSH 调用 `med-online-kb` 的唯一入口。不要发现、读取或加载外部 `med-online-kb/SKILL.md`，也不要另行调用 `med-online-kb` skill；wrapper 已负责定位并执行所需的 `med_search.py`。wrapper 失败后直接按下文来源状态分流，不检查外部 skill 目录。
- 优先取得国家药监部门公开的最新版说明书或注册文件，并核对商品名、通用名、剂型、企业、规格和适用地区。
- `references/product-name-map.md` 只是六个常用商品名的检索起点，不是适应症、剂量或疗效的事实来源。
- 六个在售产品走本 skill 的完整确定性契约；其他产品转 `med-online-kb` 做通用权威检索，不自动套用本产品族的话术或实体映射。
- 只有搜索摘要、无法打开原文或身份冲突时，不输出确定事实。

## How to Run

| 用户场景（医药代表/MSL 措辞） | 用本 skill |
|---|---|
| "德瑞妥的适应症有哪些" | ✅ 走 SOP：CDE 取说明书 → 抽「适应症」字段 |
| "贝乐林的半衰期 / 达峰时间 / 消除途径" | ✅ 抽「药代动力学」字段 |
| "天韵有哪些规格和剂型 / 甘美怎么储存 / 甘平的作用机制" | ✅ 抽对应说明书字段 |
| "得佑说明书上的用法用量是怎么写的" | ✅ **只给说明书静态文本**（见下「用法用量二义拆分」） |
| "贝乐林减重用途是否在适应症内？给当前核准范围和合规表述" | ✅ 走 `label_boundary`，给可复制“建议表述” |

1. 识别用户真正询问的产品和字段。产品不清或同名冲突会改变答案时先澄清。
2. 静默完成检索、抽取和核验。用户可见内容不得出现检索次数、接口状态、能力名、SOP、脚本、校验结果或本地路径。
3. 只交付被问事实、来源链接和必要的信息缺口；默认不创建文件，不附固定长免责声明。
4. 未取得权威说明书时进入来源状态化分流：标签事实标记“待核实”，不把未核验内容写成确定事实；机制、研究或其他非标签问题可转交相应证据 skill，不因单一来源失败而整体固定拒答。
5. 直接从结论开始，不写“已检索/已核验/已取得全部证据/现交付结果”等完成状态。

### 用法用量与安全字段二义拆分

- 说明书静态用法用量、不良反应、禁忌/慎用、警示以及妊娠哺乳、儿童、老年等特殊人群原文属于本 skill。
- 按体重/肌酐计算、特殊人群调量、联用、漏服、AE 预防或处置、真实用药后症状属于临床决策支持：药企/HCP 场景转 `pharma-clinical-use`；用户明确正在或准备用药时转 `medication-review`。
- 真实暴露后出现严重症状时先做紧急安全升级；PV 只在真实疑似不良事件中按需触发，纯静态不良反应查询不机械追加药物警戒收集清单。

## Quick Reference

证据优先级：

1. NMPA/CDE 等监管机构发布的说明书、注册文件或可验证批件。
2. 持有人/生产企业公开的最新版说明书，并核对批准文号和版本。
3. 同行评议文献只用于机制或研究结论，不能替代获批适应症、剂量和禁忌。
4. 新闻与第三方数据库只能支撑其原文直接记载的上市动态，不能冒充权威说明书。

获批与超说明书判断：

- “某成分获批”不能替代“该具体商品/持有人/剂型/规格在中国获批”。同成分的其他品牌或其他国家标签只能作为分开的比较事实。
- 先给当前产品的监管结论，再说明是否存在外部研究或其他产品获批信息；**有研究依据不等于当前产品已获批**。
- 用户询问剂量差异时，可以引用各自已获批标签的静态剂量事实并分别溯源，但不得把其他产品剂量写成当前产品的推荐方案。

### 强制 CDE 获取与来源状态分流

1. **识别产品 + 问的字段**（适应症/用法用量/规格/成分/储存/半衰期/机制/药代…）。产品名缺失 → 先问是哪个产品，不猜。
2. **强制 CDE 溯源（first-call，不可跳过）**：
   ```bash
   # 首选薄 wrapper（自动按 product-name-map 补通用名候选、跑 med-online-kb cde、定位抽取的说明书 PDF）
   python3 '<skill-dir>/scripts/fetch_facts.py' --product '德瑞妥'
   ```
   wrapper 内部调用 `med-online-kb cde --drugname ... --extract`；不要绕过它直接扫描共享目录。
   产物：当前请求根目录的 `request-context.json` 只记录本轮输入实体/候选和 attempt 绑定；独立
   attempt 目录包含说明书 PDF 与 `job.json`。这些是**内部审计材料**，不得直接复制到公开答案。
3. **直接通过 document-parser 读取当前 attempt 的说明书 PDF**，抽出被问字段原文；不得读取其他
   request/attempt 的产物。使用已安装 dispatcher，并读取其 `OUTPUT_MD`：
   ```bash
   python3 ${HERMES_HOME}/skills/document-parser/scripts/pdf_dispatcher.py -i '<当前 attempt 的说明书 PDF>'
   ```
   不要先运行 `which`、Python `import` 探测、依赖检查或临时安装；dispatcher 自行选择解析后端。
   dispatcher 缺失或失败时记录当前来源不可用状态；不改用旧 request、技术审评报告或把第三方来源冒充当前产品说明书。
4. **说明书口径作答**：每条事实绑定本轮真实取得的公开来源标识。公开来源可包含
   CDE/NMPA、产品/通用名称、acceptid、核验日期和已验证的官方 URL；**不得包含本地 PDF 路径**。
5. **说明书未载明该字段** → 明确说"说明书未载明"，**不外推、不用记忆补**。
6. **CDE/WiseDiag 取不到**（凭据、网络、403/WAF、超时或无结果）时，记录来源状态
   `forbidden` / `timeout` / `no_hit` / `unavailable`，但不要把失败过程展示给用户，也不要立即进入
   固定两行失败答案。按问题类型处理：
   - 仍然询问当前产品适应症、剂量、禁忌、获批状态等标签事实时，只交付已由其他真实来源直接支持的部分，
     其余明确标记“待 CDE 核实”；没有可安全交付的部分时说明资料缺口，但不得猜测或补写。
   - 询问机制、研究证据、领域背景或其他非标签问题时，转交 `pharma-evidence-dossier` 或
     `med-online-kb`，明确来源是公开研究/其他监管资料，不冒充当前产品 CDE 说明书。
   - 涉及个体化剂量、联用、AE 处置或特殊人群决策时，仍转 `pharma-clinical-use` / `medication-review`。
   CDE 失败本身不是调用 `boundary_or_failure` finalizer 的充分条件；该模式仅用于实体不明、越界或无法安全交付的边界。
7. **不得绕过路由层拦截**：CDE 场景仍必须通过 `med-online-kb`/当前授权来源检索，不得用百度、Google、药智、丁香园、
   直接 NMPA 页面或其他公网搜索替代既定入口。路由层对这类绕行的确定性拦截保持不变。
8. **来源不能静默替代**：第三方药品库、RxNorm、OpenFDA 或模型记忆不得替代 CDE 说明书来回答当前产品的标签事实；
   只有在用户明确询问国际通用名、研究证据或非标签背景时，才可作为对应来源使用，并清楚说明其支持范围。

引用规则：

- 给出来源类型、标题或发布机构、发布日期/更新日期（可得时）、直接 URL 和访问日期。
- 精确剂量、比例、样本量、效应值、日期等须就近附直接 URL、可公开复核的 CDE acceptid、PMID 或 DOI；无法闭环就不写数字或标“待补证据”。
- 本地抽取文件和内部记录可用于核验，但绝不向用户展示路径。

## Procedure

1. **身份核对**：商品名、通用名、剂型、企业和地区至少与原始页面一致；错误产品命中立即舍弃。
2. **字段抽取**：从原文定位用户所问字段，保留必要上下文；说明书未载明时如实写“未载明”。
3. **来源分级**：企业官网或文献只能用于用户明确要求的独立补充事实，并转相应检索/研究能力；必须说明它支持的是哪条事实，不把它写成监管说明书原文，也不得进入当前仅接受 CDE/NMPA 的产品事实 payload。
4. **风险分流**：
   - 说明书静态用法用量、不良反应、禁忌/慎用和特殊人群原文可以回答。
   - 体重/肌酐计算、特殊人群调量、联用、漏服、“如何避免/处理 AE”及真实用药后症状属于临床决策支持，不在此处代答。
5. **简洁交付**：一个字段通常用一段话即可；多个字段可用短列表。只有用户明确要完整事实卡时才扩展结构。
6. **当前会话即边界**：只使用本轮取得的监管材料，不回搜历史会话、request dump 或先前失败轨迹。获批比较题默认止于“本品标签 + 一个被问及的对照标签 + 必要安全边界”，不扩展成临床研究综述。

## 公开来源与内部审计严格分离

内部审计可记录：当前 request/attempt 目录、PDF 路径、`job.json`、命令退出码和错误详情。
这些内容只用于核验与排错，不属于用户答案。

公开答案只允许输出：

- 已从当前说明书核验的事实；
- CDE/NMPA、产品或通用名称、acceptid、核验日期；
- 本轮产物中真实存在、且域名经过允许的官方 URL。

公开答案禁止输出：

- Unix、Windows、UNC 或 `file://` 本地路径；
- `HERMES_HOME`、workspace、`.env`、`auth.json`、`job.json`；
- 脚本名、skill/tool 名、terminal、命令、request/job ID；
- API key、Authorization、token、签名 URL、localhost 或私网地址；
- “我调用了工具”“执行了命令”“检查了配置”等过程叙述。

凡是交付本轮 CDE 标签事实的正常答案，必须有本轮真实 acceptid 与核验日期；任一缺失时不得把该事实写成已核验。
来源降级或非标签问题按第 6 步分流，不因单一字段缺失自动套用 CDE 固定失败答案。
官方 URL 没有取得时可省略；不得声称“最新版”，除非版本或更新时间已被本轮明确核验。

## 输出模式与确定性渲染

完整契约见 [references/answer-contract.md](references/answer-contract.md)。根据用户问题选择一种模式：

| 模式 | 使用场景 |
|---|---|
| `direct_field` | 单个说明书字段，如适应症、规格或储存 |
| `product_card` | 产品基础信息或说明书概览 |
| `hcp_focus_card` | 无个体患者参数的医生关注/处方考量/临床应用要点；公开只显示关注点，事实 claim 仅作来源支撑 |
| `label_boundary` | 核对某用途是否载明/获批，并给出当前核准范围和 `建议表述：……` 可复制话术 |
| `expanded_label` | 用户明确要求详细、完整或逐字段内容 |
| `boundary_or_failure` | 实体含糊、无法安全交付或问题越界 |

执行顺序：

1. **每一轮都创建新的 fetch request**；用户换产品或继续追问时，清空上一轮 `entity`、`label_facts`、
   `clinical_focus`、`sources` 和 acceptid，不得复制旧 payload。代词“这个药”无法由本轮问题唯一确认时先澄清。
2. **所有路径都只在内存中构造 JSON payload，不使用 `write_file`**：正常路径只用当前 attempt 已核验
   事实；来源失败优先按上面的来源状态化分流，不自动构造 `{"mode":"boundary_or_failure"}`。
3. 正常 payload 必须带与目录一致的 `request_id`，以及只含本轮可公开原子名称的
   `allowed_public_entities`。商品名、通用名、来源和 acceptid 必须由当前 request context + attempt 授权。
4. 每条 `label_facts` 必须带唯一 `claim_id` 和 `source_ids`；每条 `clinical_focus` 必须带非空字符串数组
   `derived_from`（如 `["claim-1"]`）。不得引入被引用 claim 中不存在的英文缩写；HCP 支撑 claim 不公开。
5. 核对未获批/未载明用途时使用 `label_boundary`；必须填写 `questioned_use`、`approval_status`、
   `approved_scope`、`copy_ready_wording` 和 `derived_from`，不得只说“不能宣传”而不给替代表述。
   用户同时出现“是否在适应症内/当前核准范围/合规可用表述”时，**必须选此模式**，不得改成医学综述
   或全文关键词盘点；建议表述只复述当前核准范围与未载明边界，不扩写试验中的体重变化或其他品种。
   此模式只抽取身份字段与【适应症】；不得搜索/摘录【临床试验】、药效学或其他章节来证明“未载明”，
   `label_facts` 中的每条 claim 都必须被 `label_boundary.derived_from` 使用，不保留供补充说明的 claim。
6. 只通过一次 `terminal` 调用，把 payload 从 stdin 交给：
   `python3 '<skill-dir>/scripts/finalize_public_answer.py' --request-dir '<当前 attempt 目录>'`。
   finalizer 负责在当前 attempt 的 `public-answer/` 内落盘、render、validate，stdout 只含 canonical。
7. finalizer 退出 0 才能交付；失败时只修正 stdin payload并重试，正常 payload 最多两次。只有实体不明、
   无法安全交付或问题越界时才改用最小 `boundary_or_failure` payload；CDE 来源失败不自动触发该模式。
   不得分别调用 renderer/validator，不得读取 draft 后再总结。
8. finalizer stdout 是唯一公开 draft；最终回复必须与 stdout **逐字一致**，不得在前后追加解释、标题、
   分隔符、路径、命令、验收状态或自行改写。失败 draft 是两个相邻文本行，不是两个 Markdown
   段落；禁止在两行之间插入空行。

**交付停止规则**：finalizer 一旦退出 0，立即结束本轮；不要再读取文件、总结核验过程、引用上一轮
答案或生成第二版文本。工具 stdout 与最后一条 assistant 文本之间只允许传输层末尾换行差异。

`direct_field` 默认只给 1–2 个事实要点和一行来源，普通静态事实不重复通用 HCP 免责声明；超过预算
不得截断安全限定、否定词、剂量单位或适用人群。`hcp_focus_card` 默认 3–5 条、最多 400 个规范化
可见字符；预算只计算公开关注点，validator 拒绝过短/过长内容，renderer 永不公开支撑 claim。

## 4 条合规红线（回答必守）

1. **口径一致**：适应症、用法用量、禁忌、不良反应和剂量只按本轮说明书事实表达，不改写适用范围、不外推。
2. **不超适应症、不夸大**：研究、其他品牌或其他国家/地区的批准信息不能替代当前具体产品的中国获批状态；有研究依据不等于当前产品已获批。
3. **守法合规**：不做患者荐药，不输出无直接来源的“首个/唯一”等推广主张，不提供商业贿赂或处方量挂钩话术。
4. **越界即分流**：实体或来源未确认时不编；个体调量、联用、AE 处置和真实暴露症状转临床安全能力，紧急红旗优先升级。

## 边界（不可越过）

- **运行时不改自身部署文件**：不在运行时修改、`skill_manage` 或 patch `references/product-name-map.md`；映射只经开发仓 git 审阅更新。
- 不做竞品优劣、价格准入、购买推荐或个体化临床决策；相应转 `pharma-competitor-analysis`、`pharma-market-access`、产品推荐或 `pharma-clinical-use`。
- 无多用户或 `patient_id` 维度，不写健康档案；内部产物只落本轮 `${HERMES_HOME}` request/attempt 范围。

## Pitfalls

- 不播报“CDE 0 命中、改用兜底来源、核验已完成”等执行过程。
- 不把“交叉核验完毕、现交付结果”当作答案开场。
- 不把映射表、新闻稿或聚合站当成权威说明书。
- 不因知道通用名就推断适应症、年龄范围、剂量或疗效。
- 不把同成分其他品牌、其他剂型或境外批准状态静默套到当前产品。
- 纯“有哪些不良反应”是静态事实，不机械追加药物警戒收集清单；若上下文出现实际暴露和症状，则转临床安全分流。
- 不输出无直接来源的“国产首个、全球唯一、填补空白、供应稳定”等推广性结论。
- 不在运行时修改 `references/product-name-map.md`；映射更新只通过开发仓审阅。

## Verification

- 可按需使用 `scripts/fetch_facts.py` 定位本轮说明书材料；其命令、日志和本地文件仅供内部核验。
- 交付前确认：产品身份一致、每条事实由来源直接支持、数字可回查、未载明/未检索到项已明确、没有内部执行痕迹。

## 公开输出格式

```
<1–2 个说明书核验事实>

来源：本轮核验的 CDE 药品说明书｜<产品/通用名>｜<acceptid>｜核验日期 <date>
```

无法取得本轮 CDE 说明书时按“来源状态分流”交付：不展示排错细节，不冒充 CDE 事实；若存在其他真实来源支持的
非标签内容，可标明来源类型后部分交付，剩余内容标记“待 CDE 核实”。

## 与 med-online-kb 协作

```
用户问"德瑞妥的适应症"
   → fetch_facts.py --product 德瑞妥
        → med-online-kb med_search.py cde --drugname 德瑞妥 --extract
        → 说明书 PDF ${HERMES_HOME}/workspace/pharma-product-facts/requests/<request-id>/attempt-<n>/cde-*/ + job.json(acceptid)
   → 读当前 attempt PDF 抽「适应症」原文 → 公开答案只带事实、acceptid/核验日期和可用官方 URL
   （说明书未载明 → 明说未载明；CDE 取不到 → 标签事实标记待核实，非标签问题按来源状态转交）
```
