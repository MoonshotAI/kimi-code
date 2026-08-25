# Desktop alpha 发布通道实施方案

> 2026-08-25。为 desktop（kimi-code-app）增加 alpha 发布通道。已拍板决策：
>
> 1. alpha 版本用 **changeset pre 模式** 产生（`0.0.x-alpha.N`），合入版本 PR 后 push 自动发版（复用 release.yml 的"版本号变化即发版"判定）。
> 2. pre 模式开在**常驻 `alpha` 分支**；main 的发版语义完全不动。alpha 分支只进不出（禁止合回 main）。
> 3. 用户加入方式：**独立 alpha 安装包**——channel 随版本号自动烘焙进包，无设置项；客户端仅 `setFeedURL` 携带 channel 一处小改动（review 发现的 setFeedURL 配置替换陷阱，见下）。
> 4. alpha 产物**上 CDN**，但只新增 `alpha*.yml` 指针；`latest*.yml` 指针与 `download/` 固定入口永远只被正式版触碰。
> 5. 指针语义为**持续通道（Insiders 式）**，无例外：alpha 指针只被 alpha 发布刷新，alpha 用户一路吃后续 alpha（内容恒为正式版超集）。alpha 用户想回正式版 = 手动下载安装正式包；不做任何"把 alpha 指针刷成正式包"的收敛机制。
> 6. alpha changelog **静默降级**：不传双语 release notes，更新弹窗对 alpha 版本不显示说明（现有 404 降级逻辑天然支持）。

## 已验证的机制事实（以本仓 node_modules 源码为准）

- **channel 构建期推导**（app-builder-lib@26.15.3 `out/publish/PublishManager.js` `getResolvedPublishConfig`）：publish 配置未显式设 `channel` 且 `detectUpdateChannel` 未关（默认开）时，从 app 版本的 prerelease 段推导 channel（`0.0.21-alpha.0` → `alpha`）。推导结果同时决定：
  - 产物元数据文件名：`alpha-mac.yml` / `alpha.yml` / `alpha-linux.yml`（`updateInfoBuilder.js` `getUpdateInfoFileName`），替代正式版的 `latest*.yml`；
  - `channel: alpha` 写入安装包内 `app-update.yml`。
- **channel 运行时解析**（electron-updater@6.8.9 `out/providers/GenericProvider.js`）：`updater.channel || 当前 provider 配置的 channel`，然后 mac 请求 `${channel}-mac.yml`、win 请求 `${channel}.yml`、linux 请求 `${channel}-linux.yml`。
- **关键陷阱（review 中发现并已修）**：`setFeedURL(options)` 用入参**整体新建** provider（`AppUpdater.js` `setFeedURL`），app-update.yml 里烘焙的 `channel: alpha` 只在从未调过 `setFeedURL` 的兜底路径生效；而 `updater.ts` 常规路径每次 check 前都会 `setFeedURL({provider:'generic', url})` 切 region——不带 channel 时 alpha 包会退回轮询 `latest*.yml`。修复：`updater.ts` 每次 `setFeedURL` 显式带上 `updateChannelFromVersion(app.getVersion())` 推导的 channel（不用 `autoUpdater.channel =` setter——它会顺手强制开启 `allowDowngrade`）。
- **结论 1（修正后）：客户端仅一处小改动**——`setFeedURL` 调用携带 channel；region 双 CDN 逻辑原样生效，无设置项、无 UI 改动。
- **结论 2：落回语义天然正确**。alpha 用户升到正式版包（版本号无 prerelease 段 → channel=latest）后自动回到 latest 通道；反之装 alpha 包即加入 alpha 通道。
- **semver 合法升级**：`0.0.21-alpha.N < 0.0.21 < 0.0.22`，alpha → 同号/更高正式版都是升级，electron-updater 不拦；是否发生取决于 alpha 指针内容（决策 5）。
- **正式版零感知**：`latest*.yml` 不被 alpha 发布触碰，正式版用户的更新链路无任何变化。
- **现成陷阱确认**：`gh release list` 默认包含 prerelease——`publish-desktop-cdn.sh` 不传版本号时取 `-L 1` 会在发了 alpha 后取错（`--exclude-pre-releases` 可过滤）。
- kimi-code 核心仓无 prerelease/alpha 发版先例（已查其 workflows），本方案为首发。

## 分支模型与生命周期

- **一次性建立**：从 main 切 `alpha` 分支 → `pnpm changeset pre enter alpha`（生成 `.changeset/pre.json`，并把 `.changeset/config.json` 的 `baseBranch` 改为 `"alpha"`，见"待验证点"）→ push。
- **日常**：功能 PR 照常合 main（带 changeset）。要发 alpha 时把 main 合入 alpha；changesets/action 在 alpha 分支自动维护它自己的 "ci: release desktop" 版本 PR（pre 模式下版本为 `0.0.x-alpha.N`，与 main 的版本 PR 互不影响——两边各自消费自己分支上的 changeset 副本）。
- **发 alpha**：合入 alpha 的版本 PR → push alpha → release.yml 判定版本变化且 tag 不存在 → 四平台打包 → 创建 **prerelease** 的 GH Release（tag `v0.0.x-alpha.N`）→ 发布人本地跑 `./publish-desktop-cdn.sh 0.0.x-alpha.N` 上 CDN 并切 alpha 指针。
- **发正式版**：main 照旧。发布后把 main 合回 alpha 保持同步。
- **合并冲突规则**（main → alpha）：`apps/desktop/package.json` 版本取 **semver 较大者**（alpha 预览的同号正式版发布后，取 main 的正式版号，下一个 alpha 自然推进为下一 patch 的 `alpha.0`）；`CHANGELOG.md` 两边条目都保留。
- **禁止把 alpha 合回 main**：`pre.json` 与 alpha 版本号会污染 main 的发版语义。

## 改动清单

### 1. `.github/workflows/release.yml`

- trigger `branches` 增加 `alpha`。
- `Resolve desktop release` 步的纯 SHA 增量判定**分支无关、直接复用**；输出增加 `prerelease`（tag 含 `-` 即 true）。
- `publish-desktop-assets` 的 `gh release create` 在 `prerelease == 'true'` 时追加 `--prerelease`（`--generate-notes` 保留，alpha notes 内容长但无害）。
- mac 元数据合并步兼容 alpha 命名（见第 3 条）。
- 顺手修头注释的文档漂移：CDN 发布脚本已迁入本仓（`publish-desktop-cdn.sh`），不再在 kimi-cli-cdn-sync 仓跑 `publish-desktop.sh`。

### 2. `.github/workflows/desktop-build.yml`

- `Rename mac updater metadata per arch` 步：`mv latest-mac.yml` 写死改为通配实际产物（stable 出 `latest-mac.yml`，alpha 出 `alpha-mac.yml`），改名规则保持 `${channel}-mac-${arch}.yml`。

### 3. `scripts/merge-mac-update-yml.mjs`

- 文件名匹配从 `latest-mac-<arch>.yml` 放宽为 `(latest|alpha)-mac-<arch>.yml`，输出文件名随 channel（`latest-mac.yml` / `alpha-mac.yml`）。一次构建只可能有一种 channel（版本号唯一），按实际匹配处理即可；文本合并逻辑不变。

### 4. `publish-desktop-cdn.sh`

- **channel 判定**：版本号含 `-` → alpha，否则 latest。`POINTER_FILES` 随之切换为 `alpha-mac.yml / alpha.yml / alpha-linux.yml`。
- **消除陷阱**：不传版本号时 `gh release list` 加 `--exclude-pre-releases`（默认永远取最新正式版）。
- asset 过滤 jq 与 `_check_yml_references` 改用 channel 后的文件名。
- **alpha 发布时**：跳过 `download/` 固定入口刷新（只正式版刷）；跳过 release-notes 成套检测（决策 6）。
- 用法注释、结尾自查 curl 命令同步更新（alpha 时给 `alpha-mac.yml` 的 curl）。

### 5. `apps/desktop/src/main/updater.ts`（客户端唯一改动）

- 新增纯函数 `updateChannelFromVersion(version)`（与 `AppInfo.channel` 同语义：版本号 prerelease 段，无则 `latest`）；`applyFeedUrl` 的 `setFeedURL` 调用携带该 channel，经 `StartAutoUpdaterDeps.updateChannel` 注入（生产：`app.getVersion()` 推导）。
- `tests/main/updater.test.ts`：feed 切换断言补 `channel` 字段，新增"预发版携带 alpha channel"与版本推导的用例。

### 6. 文档

- 根 `README.md` 发布节：补 alpha 发布用法（一条命令 + "只切 alpha 指针、不动 download/" 的边界）。
- `.changeset/README.md`：补 alpha 分支 pre 模式生命周期（进入 / 发版 / main→alpha 同步 / 禁止回合）。
- `AGENTS.md`：发版相关硬约束补一条 alpha 分支规则；"常用命令"补 alpha 发布命令。

### 7. 明确不做

- 不改 `region.ts` / `electron-builder.config.cjs`（feed 分流与 channel 推导机制原样复用）。
- 不加设置项 / 通道切换 UI。
- CDN 不加 `download-alpha/` 固定入口——alpha 安装包从 GH Release（prerelease）分发，后续有需求再加。
- alpha 不走 release-notes skill、不做双语更新说明。
- 不改版本级别约束（一律 patch；alpha 是 patch 的 prerelease，不引入 minor/major）。

## 待验证点（实施时确认）

- **changesets/action 在 alpha 分支的 status 判定**：`.changeset/config.json` 的 `baseBranch: main` 会让 `changeset status` 以 main 为基准，可能干扰 alpha 分支上"是否有新 changeset"的判定。预案：在 alpha 分支把 `baseBranch` 改为 `"alpha"`（仅 alpha 分支，不回合 main）。首次 alpha 周期端到端验证版本 PR 是否正常生成与更新。
- **首次构建产物核对**：alpha 版本下四平台产物元数据确为 `alpha-mac.yml` / `alpha.yml` / `alpha-linux.yml`（本地把 `apps/desktop/package.json` 版本临时改为 `0.0.21-alpha.0` 跑 `pnpm --filter kimi-code-app run dist` 验证后改回，或直接在 alpha 分支上 workflow_dispatch 出包核对）。

## 验证计划

1. **首次 alpha 端到端**：alpha 分支版本 PR 合入 → 确认 GH Release 是 prerelease 且 assets 含 `alpha*.yml` → 本地 `./publish-desktop-cdn.sh 0.0.21-alpha.0` → curl 验证 `alpha-mac.yml` 指向 `binaries/0.0.21-alpha.0/`，且 `latest-mac.yml` 内容与发布前逐字节一致（未被触碰）。
2. **自动更新实测**：安装 `0.0.21-alpha.0` → 发 `0.0.21-alpha.1` 并切指针 → 应用内（设置→高级）手动检查更新，应提示新版本并完成升级。
3. **正式版回归**：下一次正式版发布走原流程，确认 `latest*.yml` 正常切换、`download/` 正常刷新、alpha 指针未被触碰。

## 开放问题（不阻塞，后续再说）

- alpha 用户规模上来后，是否加 `download-alpha/` 固定入口或设置内通道切换。
- alpha 版本是否值得做极简更新说明（从 changeset 文案直出，不走翻译）。
