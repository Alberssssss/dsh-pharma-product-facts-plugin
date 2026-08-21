# dsh-pharma-product-facts

English | [中文](README.zh.md)

Standalone DSH profile bundle that installs the `pharma-product-facts` skill provider and its `agent/pre-step` soft router as one Cordis plugin. The bundle contributes one `pharma-product-facts` row, so installation, disablement, reload, and removal apply to both contributions together.

## One-command installation

The GitLab project is private. After GitLab access and Git credentials for `115.159.220.241:9090` are configured, install both the skill and router into the `web` profile with one command:

```sh
dsh plugin --profile web add 'git+http://Albert@115.159.220.241:9090/Albert/dsh-pharma-product-facts.git#main'
```

The repository commits its built `lib/` output and has no install-time build script, so Git installation does not require pnpm build approval.

## Lifecycle

To stop both the provider and router without uninstalling the package, add this override to the profile's `cordis.patch.yml`:

```yaml
- id: pharma-product-facts
  disabled: true
```

Remove the override, or set `disabled: false`, to start both again. Remove the installed bundle and its layer with:

```sh
dsh plugin --profile web remove dsh-pharma-product-facts
```

## Runtime behavior

The immutable provider publishes the packaged `assets/pharma-product-facts/` directory as the skill resource base. It removes YAML frontmatter before returning the skill body; `references/` and `scripts/` remain available through `<skill_resources>`.

The router applies these rules:

- Static label facts such as indications, formulation, strength, storage, mechanism, pharmacokinetics, and label dosage route directly.
- Static safety and approval fields route only for the packaged pilot product entities. A complete product-plus-HCP-focus intent selects the skill's `hcp_focus_card` path.
- Patient-specific use, dose calculations, administration operations, adverse-event management, combinations, competitor comparisons, sales or promotional work, promotional off-label requests, registration metadata or label downloads, and evidence reviews stay outside this route.
- Only text from messages whose source is `user` is inspected. The listener delegates through `next()` and appends its instruction only to an accepted downstream batch; the hint does not prove that the model loaded the skill.

## External requirements

The bundle is self-contained for discovery and routing. Executing the packaged medical workflow still requires a Hermes-compatible `HERMES_HOME` plus deployed `med-online-kb` and `document-parser` resources. Missing external resources do not prevent the plugin from loading, but the skill's source-status rules then limit what it can safely deliver.

## Model Experience

### Soft router instructions

#### What the model sees

A matching authentic user message adds this durable user-role instruction after downstream pre-step context:

##### Verbatim soft route

```markdown
<pharma-product-facts-router>
这是软路由提示，不表示 skill 已加载。本轮用户请求可能属于获批产品身份、静态说明书事实或非个体化 HCP 关注卡。采取任务动作前，先调用 `skill` 工具并使用精确名称 `pharma-product-facts` 加载完整说明；只有加载后的说明才是执行依据。若主意图是个体患者用药、剂量计算、给药操作、不良反应处置、联用、竞品比较、销售推广、推广性超说明书请求、注册元数据/说明书下载或证据综述，不要套用此 skill，按主意图处理。
</pharma-product-facts-router>
```

#### Token effect

Conditional and fixed: one matching pre-step appends the verbatim reminder once. Nonmatching requests and a disabled bundle add no router tokens.

#### KV Cache effect

The appended user-role message preserves the earlier request prefix and extends it at the pre-step insertion point. Enabling, disabling, or changing the fixed reminder changes the prefix from that point onward.

### Bundled skill discovery and load

#### What the model sees

`@deepseek-ai/dsh-tool-skill` exposes the fixed catalog summary and, after a `skill` tool call, the frontmatter-free instruction body with the packaged resource directory.

#### Token effect

The catalog adds one fixed summary while the bundle is enabled. Loading the skill adds its complete body only in the tool result selected by the model.

#### KV Cache effect

The catalog preserves the stable prefix for a fixed enabled composition. The loaded body is appended later in the conversation; package content or enablement changes invalidate reuse at their respective insertion points.

## Known Limitations and Deferred Work

- The package is private and experimental. Installers need access to the `Albert/dsh-pharma-product-facts` GitLab project; it is not an official DSH release dependency.
- The deterministic router is a recommendation, not a dispatcher or proof of skill use; session evidence must distinguish the route hint from the later `skill` tool call.
- The packaged workflow retains external Hermes-compatible medical retrieval dependencies and cannot independently provide live CDE evidence.
