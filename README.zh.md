# dsh-pharma-product-facts

[English](README.md) | 中文

独立 DSH profile 组合包，把 `pharma-product-facts` skill（技能）提供方及其 `agent/pre-step` 软 router 作为同一个 Cordis 插件安装。该组合包只贡献一个 `pharma-product-facts` 配置项，因此安装、停用、重载和移除会同时作用于两项贡献。

## 通过 Web UI 或终端安装

### DSH Web UI

在 Web UI 的插件/软件包安装输入框中，只粘贴下面这个软件包定位符：

```text
github:Alberssssss/dsh-pharma-product-facts-plugin
```

不要把完整终端命令粘贴到该输入框。UI 会把输入值交给包管理器，因此完整命令会被误解析成格式错误的软件包定位符。

### 终端

用一条命令把 skill 和 router 同时安装到 `web` profile：

```sh
dsh plugin --profile web add github:Alberssssss/dsh-pharma-product-facts-plugin
```

仓库已提交构建后的 `lib/`，并且没有安装时构建脚本，因此通过 Git 安装不需要 pnpm 构建授权。

无论使用哪种安装方式，成功后都要重启 `web` profile Host，并新建会话。已有会话会保留其创建时的组成。

pnpm 可能提示本外部组合包的 DSH peer dependencies 在 profile 目录中缺失。DSH 会按设计通过安装侧维护的 profile module fallback 提供这些核心包，以确保所有插件共享 Host 的同一个 Cordis 实例；不要为了消除包管理器警告而在 profile 中重复安装 DSH 核心包。请用 `dsh --profile web --dump-config` 核对实际组成，并确认 `pharma-product-facts` 配置行可以加载。

## 让模型看到 skill

请选择会挂载 `@deepseek-ai/dsh-tool-skill` 的 agent preset，例如随 DSH 提供的 `standard` 或 `code`。`minimal` preset 按设计不挂载该 Consumer。把本组合包安装到 Host 层会发布 provider 和 router，但不会替一个主动省略 skill Consumer 的 preset 增加它。

模型可调用的是共享 `skill` 工具，而不是以仓库命名的工具。原生工具会话使用 `skill({ name: "pharma-product-facts" })` 加载本 skill；Code Mode 通过 `run_code` 中的 `tools.skill(...)` 发起同一次调用。Web 输入框提供 skill 菜单时，也可键入 `/pharma-product-facts ` 确定性调用。不会出现名为 `dsh-pharma-product-facts-plugin` 的工具，这是正常行为。

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

该组合包在发现和路由层面自包含。执行包内医学工作流仍需兼容 Hermes 的 `HERMES_HOME`，以及已部署的 `med-online-kb` 和 `document-parser` 资源。通过 `med-online-kb` 实时检索 CDE 还需要 Host 环境中的 `WISEDIAG_API_KEY`。外部资源或凭据缺失不会阻止插件加载，但 skill 的来源状态规则会限制它可以安全交付的内容。

本包只把 `pharma-product-facts` 注册为 skill。包内 `fetch_facts.py` wrapper 可以执行已部署的 `med-online-kb/scripts/med_search.py`，但不会把 `med-online-kb` 注册或加载成第二个 skill。包内指令已明确要求：检索失败后不得再发现或读取外部 `med-online-kb/SKILL.md`。这属于模型指令，不是文件系统访问控制；agent 最终能读取哪些本地路径，仍由当前 DSH 文件策略决定。

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
