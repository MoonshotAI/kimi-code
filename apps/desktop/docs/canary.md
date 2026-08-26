# Kimi Code Canary（内部内测版）

Kimi Code Canary 是 desktop 的内部预发布通道：**同一套代码**打出的独立身份 app
（`Kimi Code Canary`，金丝雀黄图标），与正式版并存安装、可双开。发布走 GitHub
prerelease（私有仓 `MoonshotAI/kimi-code-app`），app 内所有内测操作都通过**本机
`gh` CLI** 完成——用你自己的 GitHub 身份，任何 token 都不打进安装包。

目前只支持 macOS arm64（Apple Silicon）。

## 与正式版的关系

| 维度 | 行为 |
|---|---|
| 安装 | 并存：`/Applications/Kimi Code Canary.app`，不覆盖正式版 |
| 双开 | 可以同时运行（各自 userData，内嵌 server 用临时端口） |
| 登录态 / 会话 / 工作区 | 共享（`~/.kimi-code` 两边通用） |
| app 级状态 | 独立（userData 分离；canary 首次启动会过一次 onboarding，仅此一次） |
| `kimi-code://` 深链 | 永远归正式版（canary 不注册，OAuth 回调会唤醒正式版） |
| 自动更新 | **canary 没有 CDN 自动更新**（electron-updater 被禁用，否则会被「更新」回正式版）；更新走本文下面的黄点流程 |

## 前置要求

```bash
brew install gh
gh auth login        # 需要能读 MoonshotAI/kimi-code-app（私有仓）
```

GUI 应用看不到 Homebrew 的 PATH 没关系，app 会自动探测 `/opt/homebrew/bin/gh`
等常见路径。

## 首次安装

1. 打开 <https://github.com/MoonshotAI/kimi-code-app/releases>，找最新的
   `vX.Y.Z-canary.N`（标了 Pre-release）；
2. 下载 `KimiCodeCanary-X.Y.Z-canary.N-mac-arm64.dmg`；
3. 挂载后把 **Kimi Code Canary** 拖入「应用程序」。

命令行等价：`gh release download vX.Y.Z-canary.N --repo MoonshotAI/kimi-code-app --pattern 'KimiCodeCanary-*-mac-arm64.dmg' --dir ~/Downloads`

## 日常更新

- 启动后 app 会定时检查（启动 10s 后首次，之后每 4 小时）；发现更新的
  `-canary.N` 时**侧栏顶部亮起黄色「更新」pill**（和正式版更新同一个位置、
  同一套弹窗）。
- 更新走 **electron-updater + GitHub provider**（私有仓）：鉴权用你本机
  `gh auth token`（运行时获取，不落盘、不进安装包），**差分下载**——
  按 blockmap 只拉变化的块（通常十几 MB，而不是一百多 MB 的全量包），
  下完一键重启安装。「本次跳过」可静音该版本。
- 手动检查：debug 菜单「更新 Canary」；构建新版本：debug 菜单「重新打包
  Canary」。gh 未安装/未登录时更新不可用，菜单会给出修复提示。

## debug 菜单（PR 预览 + 升级操作）

侧栏顶部的「debug」pill（dev 与 canary 构建显示）把调试入口收在一处：

- **PR 预览…**：打开预览对话框——选择 open PR、remote 分支，或输入任意
  commit sha → 在隔离 worktree（`<userData>/pr-previews/`）里构建该代码的
  渲染层，构建完成后自动在**独立预览窗口**打开，主窗口不动。server 仍是
  当前 app 的，预览的只是界面；关掉预览窗口即退出预览（原生 View 菜单
  也有「退出 PR 预览」+ 快捷键）。预览窗口左上角的 debug pill 会变为
  黄色并显示当前预览的分支 / PR。
  - 首次预览某个目标需要 `pnpm install` + 构建，几分钟；同一目标再次预览
    会复用缓存，快很多。
  - 预览 worktree 的 git 对象来自 `<userData>/pr-previews/repo-cache.git`
    （自动维护的 bare 镜像），不碰你本机的任何 checkout。
- **更新 Canary**：立即检查 GitHub 上的最新内测版（本机 gh 身份）。
- **重新打包 Canary**：确认后触发 `desktop-build.yml`（`canary=true`）——macOS
  arm64 签名公证构建，完成后自动建 prerelease，约 20–30 分钟。
- **查看流水线**：浏览器打开 Actions 页。

同样依赖本机 `gh`（查 release、拉 PR 列表）与 git/pnpm（经 login shell
环境探测）。

## 本地打 canary 包（调试）

功能开发平时在 `pnpm dev:desktop` 里调即可（canary 的检查/下载/触发与 PR
预览在 dev 就启用）。想看**身份层**（侧栏 debug pill 与 canary 专属 UI）
不用打包：

```bash
pnpm dev:desktop:canary   # = KIMI_DESKTOP_CANARY=true pnpm dev:desktop
```

它只是模拟身份显示层——不改版本号、不动 userData（dev 继续与
正式版共享数据目录，这是刻意设计）。

完整身份（黄图标 / 独立 userData / 应用名 / 禁用 updater）要打真包：

```bash
# 版本号需要是 canary 形态，运行时据此判定身份（src/main/release-channel.ts）
node -e "const fs=require('fs');const p='apps/desktop/package.json';const pkg=JSON.parse(fs.readFileSync(p,'utf8'));pkg.version=pkg.version.split('-')[0]+'-canary.0';fs.writeFileSync(p,JSON.stringify(pkg,null,2)+'\n')"
KIMI_DESKTOP_CANARY=true pnpm --filter kimi-code-app run dist
# 打完记得 git checkout apps/desktop/package.json 恢复版本号
```

`KIMI_DESKTOP_CANARY=true` 让 electron-builder 切到 canary 身份（独立
appId/productName/黄图标/不注册深链，见 `electron-builder.config.cjs`）。

## 回退 / 退出内测

直接删除 `/Applications/Kimi Code Canary.app` 即可，正式版不受任何影响。
