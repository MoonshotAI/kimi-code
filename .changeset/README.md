# Changesets

本仓库用 [changesets](https://github.com/changesets/changesets) 管理 `kimi-code-app` 的版本与发版。

与 kimi-code 仓库的区别：**不发布 npm**。发布物是桌面端安装包（dmg / zip / exe / AppImage / deb），以 GitHub Release（tag `v<version>`）形式分发。

## 参与发版的包

只有 `kimi-code-app`（`apps/desktop`）。本仓其余 workspace 包（`kimi-code-web`、web 共享包）在 `.changeset/config.json` 的 `ignore` 里；kimi-code submodule 的包无法进 ignore（release CI 不 checkout submodule，而 ignore 要求包真实存在于 workspace），跑 `pnpm changeset` 时会在列表里看到它们——严禁选择，changeset 只允许写 `kimi-code-app`。

注意：desktop 的运行时代码包含 workspace 源码（`@moonshot-ai/web-*`、kimi-code 的 `kap-server` / `agent-core-v2` 等）。这些包的用户可见变化都要手动归因到 `kimi-code-app` 的 changeset 上，不要依赖依赖链自动 bump。

## 发版流程

1. 有用户可见变化时，在功能 PR 里跑 `pnpm changeset`，选 `kimi-code-app` 和 bump 级别（patch / minor / major），写面向用户的一句描述，把生成的 `.changeset/*.md` 一起提交。
2. changeset 合入 `main` 后，`.github/workflows/release.yml` 里的 changesets/action 会自动开 / 更新一个 `ci: release desktop` 版本 PR（跑 `changeset version`：bump 版本号、更新 `apps/desktop/CHANGELOG.md`、删掉已消费的 changeset）。
3. 人工 review 并合并版本 PR。workflow 判定本次 push 改变了 `apps/desktop/package.json` 的版本号、且该版本还没有对应 tag 时（普通 PR 不会改变版本号，不触发发版）：
   - 调用 `desktop-build.yml`（签名 + 公证）并行打出四平台安装包；
   - 创建 GitHub Release（tag `v<version>`，release notes 自动生成）；
   - 把 dmg / zip / exe / AppImage / deb 全部上传为该 release 的 assets。
4. 版本号与 tag 已存在则整段跳过（幂等）；打包失败不会产生 tag，修复后重跑即可。

测试 / 重构 / 文档类改动通常不需要 changeset。

## alpha 预发版通道

常驻 `alpha` 分支处于 pre 模式（`.changeset/pre.json`，由 `pnpm changeset pre enter alpha` 进入）。规则：

1. **分支只进不出**：功能改动一律先合 main，再把 main 合入 alpha；禁止把 alpha 合回 main（pre.json 与 alpha 版本号会污染 main 的发版语义）。
2. changesets/action 在 alpha 分支独立维护 `ci: release desktop` 版本 PR：pre 模式下 `changeset version` 出 `0.0.x-alpha.N`，与 main 的版本 PR 各自消费各自分支上的 changeset，互不影响。
3. 合并 alpha 的版本 PR 即自动发版（复用"版本号变化即发版"判定）：GH Release 打 prerelease 标记，自动更新元数据为 `alpha*.yml`（electron-builder 从版本号 prerelease 段推导 channel，安装包内烘焙 `channel: alpha`）。
4. CDN 发布：`./publish-desktop-cdn.sh 0.0.x-alpha.N`——只切 alpha 通道指针；`latest*.yml` 与 `download/` 固定入口永远只被正式版触碰。alpha 不发双语 changelog（客户端静默降级）。
5. main → alpha 合并冲突规则：`apps/desktop/package.json` 版本取 semver 较大者（alpha 预览的同号正式版发布后取 main 的正式版号，下一个 alpha 自然推进为下一 patch 的 `alpha.0`）；`apps/desktop/CHANGELOG.md` 两边条目都保留。
6. alpha 用户想回正式版 = 手动安装正式包；不做任何把 alpha 指针指向正式版的收敛机制。

完整方案见 `docs/plans/2026-08-25-desktop-alpha-channel.md`。
