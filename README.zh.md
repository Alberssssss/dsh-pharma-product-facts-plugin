# dsh-pharma-product-facts

[English](README.md) | 中文

独立 DSH 组合包，在同一个 Cordis 配置行中提供 `pharma-product-facts` skill、窄范围 `agent/pre-step` router，以及两个 DSH 原生证据工具。安装、停用、重载和卸载会原子地作用于全部四项贡献。

业务流程已改为 DSH 内部自包含：使用随 DSH 提供的 `web_search` 发现 URL，由包内受限工具读取 CDE/NMPA HTML 或 PDF，再由包内确定性 finalizer 生成答案。运行时不执行外部医学 skill、本地 Python 脚本或用户主目录资源。

## 安装

在 DSH Web UI 的插件输入框中只粘贴：

```text
github:Alberssssss/dsh-pharma-product-facts-plugin
```

终端安装命令：

```sh
dsh plugin --profile web add github:Alberssssss/dsh-pharma-product-facts-plugin
```

安装后重启 `web` profile Host 并新建会话。旧会话会保留其创建时的组成和 skill 正文。

仓库提交了经过验证的预构建 `lib/`，且不声明安装期脚本，因此全新 DSH profile 可以安装该 Git 包，无需为 pnpm 增加 `allowBuilds` 例外。源码 checkout 仍可通过 `pnpm run build` 独立构建。适合生产使用时可固定已评审 commit：

```text
github:Alberssssss/dsh-pharma-product-facts-plugin#<commit>
```

DSH 可能提示 profile 目录中缺少 peer 软件包，这是因为 Host 通过安装侧 module fallback 提供共享核心包。不要仅为消除警告而安装第二份 Cordis 或 DSH 核心。可用以下命令核对最终配置行：

```sh
dsh --profile web --dump-config
```

## 模型可见性

使用挂载 `@deepseek-ai/dsh-tool-skill` 的 preset，例如 `standard` 或 `code`。共享 skill 工具通过 `skill({ name: "pharma-product-facts" })` 加载本包；不会出现以 GitHub 仓库名命名的工具。

插件同时注册两个模型可见工具：

- `pharma_product_facts_fetch_source`：只接受 CDE/NMPA 主机上的 HTTPS URL；只跟随同源跳转；限制响应时间和大小；抽取 HTML、文本或 PDF；并要求正文出现用户所问的确切产品名。
- `pharma_product_facts_finalize`：接收精确原文和当前会话的 evidence id，拒绝跨会话或被改写的证据，自动派生来源 URL，并渲染唯一公开答案。

Skill 只用 DSH `web_search` 发现候选官方 URL；搜索摘要不能作为说明书证据。标准 DSH 基础 profile 已提供 `web_search`，实时发现仍要求其已配置的搜索 provider 可用。

## 运行时安全

- 证据按 DSH agent/session 隔离，并只保存在有界内存中。
- 来源工具不发送 cookie 或凭据；会拒绝非监管域名、HTTP、URL 内凭据、非默认端口、跨域跳转、不支持的媒体、超大响应和产品身份不匹配。
- PDF 通过维护中的 `unpdf` 依赖在包内解析，不需要外部文档服务。
- Finalizer 会把每段公开引用重新与已取正文匹配，并禁止用截断文档证明某用途“不存在”。
- 公开答案会拒绝本地路径、疑似凭据、工具名及执行过程叙述。

本包不能保证网络或监管网站始终可用。没有取得完整且产品匹配的官方来源时，skill 会返回有限的“未核实”答案，不用模型记忆补全标签事实。

## 配置

所有随部署变化的资源限制都属于同一插件配置行。按 id 覆盖 bundle 行时需要重述其名称：

```yaml
- id: pharma-product-facts
  name: dsh-pharma-product-facts
  config:
    fetchTimeoutMs: 30000
    sourceToolTimeoutMs: 35000
    maxResponseBytes: 12000000
    maxSourceChars: 180000
```

其余默认值为 `maxUrlChars: 4096`、`maxRedirects: 3`、`maxEvidenceScopes: 64` 和 `maxEvidenceRecordsPerScope: 24`。需要公开标识运营方时也可配置 `userAgent`。非法数值、短于抓取超时的工具超时，以及不安全的 User-Agent 文本会在插件加载时直接报错。HTTPS 要求和 CDE/NMPA 主机白名单属于固定安全规则，不能通过配置放宽。

## 路由边界

Router 会为产品身份、静态说明书事实、标签安全字段、获批用途边界和非个体化 HCP 关注卡推荐本 skill。患者个体剂量或给药、不良事件处置、联用、竞品比较、商业推广、注册文件下载和证据综述不进入该路由。Router 提示不等于实际使用；应在会话日志中继续检查后续 `skill` 调用和证据工具调用。

## 生命周期

一次停用全部贡献：

```yaml
- id: pharma-product-facts
  disabled: true
```

卸载组合包：

```sh
dsh plugin --profile web remove dsh-pharma-product-facts
```

## 开发与验证

该 Git 仓库完全独立：所有软件包版本都是普通 registry 范围，没有 `workspace:` 依赖，`pnpm run build` 可以只基于本 checkout 构建。Git 安装直接使用已提交的 `lib/`，不会执行依赖生命周期脚本。

```sh
pnpm install
pnpm run typecheck
pnpm run test:coverage
pnpm run build
pnpm run pack:check
```

本包仍是外部插件，不属于 DeepSeek Harness 官方发布组件。医学正确性仍取决于实际选择和引用的公开来源；确定性校验可以减少来源替换与执行痕迹泄漏，但不能替代临床或法规审核。
