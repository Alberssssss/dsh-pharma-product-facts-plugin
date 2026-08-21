# pharma-product-facts 公开答案契约

模型不直接生成或单独写入最终文本。它先根据**当前 request/attempt 已核验的说明书**构造 JSON
payload，再把 payload 从标准输入交给 `scripts/finalize_public_answer.py`。finalizer 在当前 attempt 内完成
payload 落盘、确定性渲染、来源/实体/路径绑定与校验，stdout 只返回唯一 canonical 答案。

## 模式

| mode | 场景 | 正文预算 |
|---|---|---|
| `direct_field` | 单个说明书字段 | 最多 1–2 条、220 个规范化可见字符 |
| `product_card` | 产品基础信息概览 | 最多 6 条、400 个规范化可见字符 |
| `hcp_focus_card` | 非个体化 HCP 关注点 | 3–5 条、最多 400 个规范化可见字符 |
| `label_boundary` | 核对获批/未载明范围并给出可复制表述 | 固定 3 行业务内容 + 1 行来源 |
| `expanded_label` | 用户明确要求详细内容 | 不设短卡预算，不得重复来源模板 |
| `boundary_or_failure` | 实体含糊、无法安全交付或越界 | 2–4 行边界说明 |

`direct_field` / `product_card` 超出字符预算时不得截断安全限定、否定词或剂量单位，
而是自动按 `expanded_label` 渲染。`hcp_focus_card` 少于 3 条或超出 5 条/400 字时 validator 必须拒绝；
renderer 仍只渲染关注点，绝不公开内部支撑 claim。

## Payload

```json
{
  "mode": "hcp_focus_card",
  "request_id": "facts-current-request",
  "allowed_public_entities": ["贝乐林", "利拉鲁肽注射液"],
  "title": "产品或通用名称",
  "entity": {
    "input_name": "用户问题中的名称",
    "canonical_name": "本轮说明书确认名称",
    "confirmation_status": "confirmed",
    "confirmed_by_source_id": "cde-source-1"
  },
  "label_facts": [
    {
      "claim_id": "claim-1",
      "text": "当前说明书已核验事实",
      "source_ids": ["cde-source-1"]
    }
  ],
  "clinical_focus": [
    {
      "text": "由说明书事实直接衍生的非个体化关注点",
      "derived_from": ["claim-1"]
    }
  ],
  "sources": [
    {
      "source_id": "cde-source-1",
      "authority": "CDE",
      "document": "药品说明书",
      "product": "产品或通用名称",
      "acceptid": "本轮真实受理号",
      "verified_date": "YYYY-MM-DD",
      "url": "本轮真实取得且允许公开的官方 URL"
    }
  ]
}
```

`allowed_public_entities` 只列本轮可公开的**原子名称**，不要放“商品名：X（通用名：Y）”这类组合串。
它必须由本轮 request context、当前 attempt 的 CDE 查询实体及当前来源共同授权。正常 payload 的
`request_id` 必须与 `requests/<request-id>/attempt-NN` 中的目录标识一致。

`label_boundary` 使用同一套 `entity`、`label_facts`、`sources` 和 request/entity lock，并增加：

```json
{
  "mode": "label_boundary",
  "label_boundary": {
    "questioned_use": "减重或体重管理适应症",
    "approval_status": "not_listed",
    "approved_scope": "当前说明书载明的核准范围",
    "copy_ready_wording": "目前核准范围为……；当前说明书未载明减重或体重管理适应症。",
    "derived_from": ["claim-1"]
  }
}
```

`approval_status` 只允许 `listed` / `not_listed`。renderer 固定输出“核对结论”“当前核准范围”
和“建议表述”（不另起标题行），保证不是只拒绝，而是给出可直接复制的合规替代表述。此模式只用
身份字段和【适应症】claims；每条 `label_facts` 都必须被 `label_boundary.derived_from` 使用，不得保留
临床试验、药效学或其他章节 claim 供模型在 canonical 后追加说明。

`boundary_or_failure` 只用于实体含糊、无法安全交付或问题越界；只有这些边界才可使用 `failure_message`，renderer
只接受 2–4 个非空文本行。**CDE/解析来源失败本身不强制进入此模式**：应由上层按
`verified/no_hit/forbidden/timeout/unavailable` 做来源状态化分流，保留其他真实来源支持的部分，并将标签事实
缺口标记为“待 CDE 核实”。如果没有任何可安全交付内容，才使用边界模式；不得把错误详情、路径、命令或
WAF 页面内容放进 `failure_message`。

## 字段所有权

- `label_facts[].text`：只能来自当前说明书。
- `label_facts[].source_ids`：必须指向 `sources[].source_id`。
- `clinical_focus[].derived_from`：必须是非空字符串数组，并指向当前 payload 的 `claim_id`。
- `label_boundary.derived_from`：必须指向当前 payload 的说明书 claim；范围和建议表述不得新增这些
  claim 中没有的英文缩写。
- `hcp_focus_card` 的 `label_facts` 是内部可追溯支撑，公开 renderer 只显示
  `clinical_focus`，避免把完整事实与衍生关注重复输出；来源仍由这些 claim 解析。
- `clinical_focus` 不得新增其 `derived_from` claim 中不存在的英文缩写。
- `entity.confirmation_status`：交付当前产品标签 claim 的正常回答必须为 `confirmed`，并通过
  `confirmed_by_source_id` 指向支持公开 claim 的本轮 CDE 来源；`candidate/unknown` 不得进入产品标签事实模式，
  只能澄清实体、转交非标签问题或进入确有必要的边界模式。
- `sources`：只包含公开来源字段；本地路径、命令、request/job ID 和鉴权信息不得放入 payload。
- `sources[].acceptid` 必须存在于当前 attempt 的 `job.json`，并且同目录必须有对应的说明书 PDF；
  不接受上一轮或另一 attempt 的受理号。
- 每轮必须重建 `label_facts`、`clinical_focus`、`sources` 和实体锁；不得复用上一轮集合。
- 未核验用户前提不得原样转写成事实。

## 渲染规则

- renderer 忽略未列入白名单的字段，但 validator 会拒绝 payload 中的额外字段。
- `direct_field` 不重复通用 HCP 免责声明，只保留 1–2 个事实要点和一行来源。
- `hcp_focus_card` 只渲染关注点；3–5 条、最多 400 个规范化可见字符，预算不重复计算隐藏的支撑 claim。
- `label_boundary` 固定渲染是否载明、当前核准范围、`建议表述：……` 和一行来源，不追加通用综述模板。
- claim、关注点和来源组件中的换行会被规范化，不能注入额外段落。
- CDE 标签事实答案必须有本轮真实 acceptid 与核验日期；任一缺失时 validator 不得把该事实标为已核验。
  来源状态化的非标签交付不套用 CDE 标签字段，也不自动转成固定失败模式。
- URL 可选；本轮没有取得允许公开的官方 URL 时省略，不补写。
- finalizer 输出后模型不得再编辑；`validate_public_answer.py` 会检查 canonical 输出是否被改写、
  来源/claim/实体引用是否闭合、request/attempt 是否匹配、公开实体是否越锁，以及是否含路径、
  过程、凭据或不允许的 URL。
- 边界模式的最终回复必须与其 payload 的 canonical draft 逐字一致；不得增加标题、前言、分隔符、内部故障
  信息或验收状态；也不得增加“validator 已通过”“逐字交付如下”等过程句。来源状态化的部分交付不套用
  固定两行模板，但仍必须隐藏内部路径、命令、WAF 页面和凭据。

## 单次 finalizer 调用

只允许通过一次 `terminal` 调用把 JSON 从 stdin 交给 finalizer；不得先用 `write_file` 创建 payload，
不得再分别运行 renderer、validator 或读取 draft。先把 `<skill-dir>` 替换为 `<skill_resources>` 中
`Base directory for this skill` 的绝对目录：

```bash
python3 '<skill-dir>/scripts/finalize_public_answer.py' \
  --request-dir '<当前 requests/<request-id>/attempt-NN>' <<'JSON'
{...本轮 payload...}
JSON
```

退出 0 时 stdout 的全部内容就是最终回复；下一条且最后一条 assistant 消息必须与 stdout 逐字一致。
退出非 0 时只修正 stdin payload 后重试；正常 payload 最多两次，仍失败时仅在确属实体/安全/越界边界时提交最小
`{"mode":"boundary_or_failure"}`。CDE 来源失败应返回上层来源状态，不因 finalizer 失败自动变成固定 CDE 拒答。
finalizer 会把成功 payload 和 draft 保存到当前 attempt 的
`public-answer/`，不会写入共享 workspace 根目录。
