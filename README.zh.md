# dsh-pharma-product-facts

[English](README.md) | 中文

独立 DSH profile 组合包，把 `pharma-product-facts` skill（技能）提供方及其 `agent/pre-step` 软 router 作为同一个 Cordis 插件安装。该组合包只贡献一个 `pharma-product-facts` 配置项，因此安装、停用、重载和移除会同时作用于两项贡献。

## 单命令安装

用一条命令把 skill 和 router 同时安装到 `web` profile：

```sh
dsh plugin --profile web add github:Alberssssss/dsh-pharma-product-facts-plugin
```

仓库已提交构建后的 `lib/`，并且没有安装时构建脚本，因此通过 Git 安装不需要 pnpm 构建授权。

## 生命周期

如果要保留安装但同时停止提供方和 router，请把以下覆盖项加入 profile 的 `cordis.patch.yml`：

```yaml
- id: pharma-product-facts
  disabled: true
```

删除该覆盖项或设置 `disabled: false`，即可重新启动两者。使用以下命令移除已安装的组合包及其配置层：

```sh
dsh plugin --profile web remove dsh-pharma-product-facts
```

## 运行时行为

不可变提供方把包内 `assets/pharma-product-facts/` 目录发布为 skill 资源基底。它返回 skill 正文前会移除 YAML frontmatter；模型仍可通过 `<skill_resources>` 使用 `references/` 和 `scripts/`。

Router 应用以下规则：

- 适应症、剂型、规格、储存、机制、药代和说明书用法用量等静态标签事实会直接命中。
- 静态安全与获批字段只对包内试点产品实体命中。完整的「产品 + HCP 关注」意图会选择该 skill 的 `hcp_focus_card` 路径。
- 个体患者用药、剂量计算、给药操作、不良事件处置、联用、竞品比较、销售或推广工作、推广性超说明书请求、注册元数据或说明书下载以及证据综述均不进入本路由。
- Router 只检查来源为 `user` 的文本消息。监听器通过 `next()` 委派，并且只对下游接受的消息批追加指令；该提示不能证明模型已经加载 skill。

## 外部要求

该组合包在发现和路由层面自包含。执行包内医学工作流仍需兼容 Hermes 的 `HERMES_HOME`，以及已部署的 `med-online-kb` 和 `document-parser` 资源。外部资源缺失不会阻止插件加载，但 skill 的来源状态规则会限制它可以安全交付的内容。

## 模型体验

### 软 router 指令

#### 模型看到什么

真实用户消息命中时，系统会在下游步骤前上下文之后追加以下持久用户角色指令：

##### 软路由逐字文本

```markdown
<pharma-product-facts-router>
这是软路由提示，不表示 skill 已加载。本轮用户请求可能属于获批产品身份、静态说明书事实或非个体化 HCP 关注卡。采取任务动作前，先调用 `skill` 工具并使用精确名称 `pharma-product-facts` 加载完整说明；只有加载后的说明才是执行依据。若主意图是个体患者用药、剂量计算、给药操作、不良反应处置、联用、竞品比较、销售推广、推广性超说明书请求、注册元数据/说明书下载或证据综述，不要套用此 skill，按主意图处理。
</pharma-product-facts-router>
```

#### Token 影响

影响有条件且固定：每个命中的步骤前阶段会追加一次上述逐字提醒。请求未命中或组合包被停用时，不增加 router token。

#### KV Cache 影响

追加的用户角色消息保留更早的请求前缀，并在步骤前插入点扩展该前缀。启用、停用或修改固定提醒会从该位置起改变前缀。

### 组合包内 skill 的发现与加载

#### 模型看到什么

`@deepseek-ai/dsh-tool-skill` 向模型提供固定目录摘要；调用 `skill` 工具后，还会提供已移除 frontmatter 的指令正文与包内资源目录。

#### Token 影响

组合包启用时，目录增加一条固定摘要。只有模型选择加载该 skill 时，其完整正文才会进入工具结果。

#### KV Cache 影响

在启用状态固定时，目录保持稳定前缀。加载后的正文在会话后部追加；包内容或启用状态变化会分别从对应插入点起使缓存不可复用。

## 已知限制与延后工作

- 本包为外部实验性插件，不属于 DSH 正式发布依赖。
- 确定性 router 只提供建议，不是 dispatcher，也不能证明 skill 已被使用；会话证据必须区分路由提示与后续 `skill` 工具调用。
- 包内工作流仍依赖兼容 Hermes 的外部医学检索资源，无法独立提供实时 CDE 证据。
