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
