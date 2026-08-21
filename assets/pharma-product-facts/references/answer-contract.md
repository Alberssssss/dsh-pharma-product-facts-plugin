# DSH 原生答案参数契约

本 skill 的正常答案只由 `pharma_product_facts_finalize` 生成。模型不能自行提供来源 URL；finalizer 会从当前 DSH 会话中 `pharma_product_facts_fetch_source` 已验证并缓存的 evidence id 派生来源。

## 共同字段

| 字段 | 规则 |
|---|---|
| `mode` | `direct_field`、`product_card`、`hcp_focus_card`、`label_boundary`、`expanded_label` 或 `boundary_or_failure` |
| `product` | 正常模式必填，必须与获取来源时使用的确切产品名相同 |
| `title` | 正常模式必填或默认等于产品名；必须包含 `product` |
| `evidence_id` | 必须由当前 agent 会话中的来源工具返回；不能跨会话复用 |
| `quote` / `scope_quote` | 必须是已抽取正文中的连续精确原文，规范化空白后逐字匹配 |

## 正常事实

```json
{
  "mode": "product_card",
  "product": "产品名",
  "title": "产品名（通用名仅在原文已确认时填写）",
  "facts": [
    {
      "field": "适应症",
      "quote": "官方正文中的连续精确原文",
      "evidence_id": "ev-0123456789abcdef01234567"
    }
  ]
}
```

- `direct_field`：1–2 条。
- `product_card`：1–6 条。
- `expanded_label`：1–12 条。
- 来源由 evidence record 自动去重；输出只含官方标题、URL 与访问日期。

## HCP 关注卡

```json
{
  "mode": "hcp_focus_card",
  "product": "产品名",
  "title": "产品名",
  "clinical_focus": [
    {
      "text": "简洁、非个体化的关注点",
      "quote": "直接支持该关注点的官方原文",
      "evidence_id": "ev-0123456789abcdef01234567"
    }
  ]
}
```

必须 3–5 条，总计不超过 400 个规范化字符。关注点中的数字和英文缩写必须出现在对应引用中。

规范输入只包含 `mode`、`product`、`title` 与 `clinical_focus`，不提交 `facts`、`label_boundary` 或 `failure_message`。为避免模型因冗余字段进入重试循环，finalizer 只额外容忍一种情况：`label_boundary.approval_status` 为 `listed`，且其 `evidence_id` 与规范化后的 `scope_quote` 完全重复某条 `clinical_focus` 证据。该重复对象仅用于校验，不会生成第二种输出；`not_listed` 或不重复的边界对象仍会被拒绝。

## 核准用途边界

```json
{
  "mode": "label_boundary",
  "product": "产品名",
  "title": "产品名",
  "label_boundary": {
    "questioned_use": "被问用途",
    "approval_status": "not_listed",
    "scope_quote": "当前核准范围原文",
    "evidence_id": "ev-0123456789abcdef01234567"
  }
}
```

`not_listed` 只有在完整、未截断来源文本确实不含被问用途时才可使用。finalizer 自动生成边界结论与合规建议表述。

## 安全失败

```json
{
  "mode": "boundary_or_failure",
  "failure_message": ["第一行", "第二行"]
}
```

接受 2–4 个非空文本行；其他数量会使用包内安全默认文本。任何模式都会拒绝本地路径、凭据样式、内部工具名与执行过程叙述。

若 finalizer 返回模式字段错误，只能复用当前 evidence 立即纠正一次参数，不得重新搜索或抓取来源。纠正后仍失败时停止工具调用。
