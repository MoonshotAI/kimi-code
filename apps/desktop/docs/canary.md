# Kimi Code Canary（内部内测版）

Kimi Code Canary 是 desktop 的内部预发布通道：**同一套代码**打出的独立身份 app
（`Kimi Code Canary`，金丝雀黄图标），与正式版并存安装、可双开。发布走 GitHub
prerelease（私有仓 `MoonshotAI/kimi-code-app`），人工发布到 CDN 后，客户端从 CDN 检查和下载更新，无需 GitHub 登录。

支持 macOS arm64（Apple Silicon）、Windows x64 和 Linux x64（AppImage、deb、rpm）。

Linux Canary 使用独立的 `kimi-code-canary` 可执行文件、deb/rpm 包名、桌面入口和应用元数据，可与正式版并存。登录与会话数据仍共享 `~/.kimi-code`。

Linux 产物随 release 分支更新自动构建，CDN 仍需手动发布。发布脚本要求三个平台产物齐全，并更新独立的 `canary-linux.yml` 和 `desktop/canary/download/` 下的 AppImage、deb、rpm 下载入口，不改正式版的 `latest-linux.yml` 或 `desktop/download/`。包含 Linux 支持的新脚本不能用于缺少 Linux 产物的历史 Canary 发布。

`canary-linux.yml` 包含 Linux 安装包的更新信息；AppImage、deb、rpm 使用各自的安装方式。本改动不引入 apt/yum 软件源。客户端 CDN 更新功能需要实际构建分支包含配套 updater 改动（main 对应 #865，当前 release 对应 #866）；仅上传清单不代表已安装客户端能自动更新。

Linux 打包在 `afterPack` 后仍会重新生成更新配置，因此打包 hook 同时设置本次 packager 的缓存目录来源；最终 AppImage、deb、rpm 必须全部验证 `kimi-code-canary-updater`。打包元数据的 `desktopName` 与启动器 `kimi-code-canary.desktop` 一致。PR 的 Linux packaging 检查只生成并解包验证安装包，不上传 GitHub Release 或 CDN。

## 与正式版的关系

| 维度 | 行为 |
|---|---|
| 安装 | 并存：`/Applications/Kimi Code Canary.app`，不覆盖正式版 |
| 双开 | 可以同时运行（各自 userData，内嵌 server 用临时端口） |
| 登录态 / 会话 / 工作区 | 共享（`~/.kimi-code` 两边通用） |
| app 级状态 | 独立（userData 分离；canary 首次启动会过一次 onboarding，仅此一次） |
| `kimi-code://` 深链 | 永远归正式版（canary 不注册，OAuth 回调会唤醒正式版） |
| 自动更新 | 独立 CDN Canary 更新清单，启动后和定时检查，不切换到正式版 |

## 首次安装

1. 打开 <https://github.com/MoonshotAI/kimi-code-app/releases>，找最新的
   `vX.Y.Z-canary.N.A.gSHA`（标了 Pre-release）；
2. 下载 `KimiCodeCanary-X.Y.Z-canary.N-mac-arm64.dmg`；
3. 挂载后把 **Kimi Code Canary** 拖入「应用程序」。

命令行等价：`gh release download vX.Y.Z-canary.N --repo MoonshotAI/kimi-code-app --pattern 'KimiCodeCanary-*-mac-arm64.dmg' --dir ~/Downloads`

## 日常更新

CI 构建完成后，也可以在 Actions 运行摘要点击 `Download DMG (darwin-arm64)`，直接下载 DMG；Artifacts 中同名的 `.dmg` 文件不再额外套 ZIP。原有发布包继续保留，GitHub prerelease 的发布与更新流程不变。

CI 中 macOS 签名、公证固定开启，无需勾选或传入参数；上传前会检查 DMG 和 ZIP 内实际应用的 Developer ID 签名、公证票据和 Gatekeeper 评估，证书缺失、检查或上传失败都会阻止 prerelease 发布。本地打包方式不变。

- 启动后 app 会定时检查（启动 10s 后首次，之后每 30 分钟；正式版为每 4 小时）；发现更新的
  `-canary.N` 时**侧栏顶部亮起黄色「更新」pill**（和正式版更新同一个位置、
  同一套弹窗）。
- 更新从国内或海外 CDN 下载，沿用正式版的下载进度、自动下载设置和重启安装流程；默认只自动检查，下载由用户触发。下载完成后也会在退出时安装。
- 手动检查：debug 菜单「更新 Canary」，无需安装或登录 gh。
- debug 菜单显示目标正式版、完整 Canary 版本和提交。更新弹窗展示目标版本与来源说明；GitHub 构建完成后仍需人工发布 CDN 才会收到更新。
- Canary 仅接受 Canary 更新，禁止自动降级；Preview 不启用自动更新。

## debug 菜单（升级操作）

侧栏顶部的「debug」pill（dev 与 canary 构建显示）把调试入口收在一处：

- **更新 Canary**：立即检查 CDN 上的最新内测版，无需 gh 登录。
- **从正式版导入界面设置…**：把正式版的 localStorage（置顶、外观等 UI
  偏好）复制到 Canary——确认后重启完成导入，原设置备份为 `leveldb.bak`。
  正式版需保持退出（运行中会提示先退出）。仅真 Canary 构建显示。

## 本地打 canary 包（调试）

功能开发平时在 `pnpm dev:desktop` 里调即可（canary 的检查/下载在 dev
就启用）。想看**身份层**（侧栏 debug pill 与 canary 专属 UI）
不用打包：

```bash
pnpm dev:desktop:canary   # = KIMI_DESKTOP_CANARY=true pnpm dev:desktop
```

它只是模拟身份显示层——不改版本号、不动 userData（dev 继续与
正式版共享数据目录，这是刻意设计）。

完整身份（黄图标 / 独立 userData / 应用名 / 独立更新通道）要打真包：

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

## release 分支构建与手动 CDN 发布

`release/*` 周更分支的每次 push 自动构建 macOS arm64、Windows x64 和 Linux x64，并上传 GitHub prerelease；hotfix 补丁分支被 branch-kind 闸门跳过（可用 `gh workflow run desktop-build.yml -f canary=true --ref release/...` 手动兜底，不传 --ref 会在默认分支构建）；不会上传 CDN。手动 `desktop-build.yml` 开启 `canary` 也可构建。

目标版本优先采用当前 changesets 计算出的 desktop 新版本；changesets 已消费时使用本分支 `.changeset/release-plan.json` 中与 package.json 一致的版本（依赖 release 分支发版流程）。没有 desktop 发版计划时中止。其他分支手动构建必须填写 `target-version`；release 分支填入与计划不一致的目标版本也会中止。

例如 `1.0.5-canary.108.2.gabc12345` 表示 1.0.5 预发布、第 108 次流水线、第 2 次重试、提交 abc12345。构建仅临时写 package.json，不消费 changesets、不回写分支。GitHub Release 标注来源分支和完整提交。重试必须重跑整条流水线，确保三个平台使用同一版本。

人工确认三个平台安装包后运行：

```bash
./publish-desktop-cdn.sh 1.0.5-canary.108.2.gabc12345
```

发布脚本先检查三个平台产物和更新清单，再上传国内、海外版本目录，最后更新 `desktop/canary-mac.yml`、`desktop/canary.yml`、`desktop/canary-linux.yml`，以及独立下载入口：

- `https://code.kimi.com/kimi-code/desktop/canary/download/KimiCodeCanary-mac-arm64.dmg`
- `https://code.kimi.com/kimi-code/desktop/canary/download/KimiCodeCanary-win-x64.exe`
- `https://code.kimi.com/kimi-code/desktop/canary/download/KimiCodeCanary-linux-x86_64.AppImage`
- `https://code.kimi.com/kimi-code/desktop/canary/download/KimiCodeCanary-linux-amd64.deb`
- `https://code.kimi.com/kimi-code/desktop/canary/download/KimiCodeCanary-linux-x86_64.rpm`
- 海外入口使用 `https://code.kimi.ai/kimi-code/` 下的相同路径。

`--artifacts-only` 不更新清单或固定入口。正式版的 `latest*.yml` 和 `desktop/download/` 不变。单一 Canary 通道跨目标版本滚动；同时维护多个 release 分支时，由发布人选择哪次构建进入 CDN。GitHub 上构建完成不代表 CDN 已更新。

Windows 使用独立应用 ID、黄色图标和更新缓存目录。登录与会话仍与正式版共享 `~/.kimi-code`。

旧 Canary 仍通过 GitHub 更新。首次发布这套改动时保留 GitHub prerelease，旧客户端先通过 GitHub 升级一次；新客户端后续从 CDN 更新。也可以从 CDN 独立入口下载安装。首次安装的 Windows Canary 直接使用 CDN。

### Canary 更新说明

构建和 GitHub prerelease 不再生成 changelog，`publish-desktop-cdn.sh` 也不会从 GitHub Release 下载这些资产。发布人需在运行上述发布脚本后，按 `.agents/skills/release-notes` 的整理规则准备中英双语说明；整理版上传前，客户端拉取返回 404 并静默降级，不得上传原始 commit 罗列兜底。

数据源不是 `apps/desktop/CHANGELOG.md`，也不要把完整 Canary 版本交给该 skill 做稳定版小节校验。以**发布本版本前 CDN Canary 指针实际指向的上一线上版本**到本 tag 的 compare 区间为准，不直接按发布时间取上一 GitHub prerelease，避免中间有构建未进 CDN 时漏掉用户尚未收到的改动。先读取当前指针确定 `previous`：

```bash
previous=$(curl -fsSL --noproxy '*' \
  "https://code.kimi.com/kimi-code/desktop/canary-mac.yml?_=$(date +%s)" | \
  sed -n 's/^version:[[:space:]]*//p')
[ -n "$previous" ] || { echo "未读到当前 CDN Canary 版本"; exit 1; }
previous="v${previous}"
current=v1.0.5-canary.108.2.gabc12345
gh api "repos/MoonshotAI/kimi-code-app/compare/${previous}...${current}"
```

读取区间内新增的 `.changeset/*.md` 摘要和非机械提交文案；submodule bump 提取其携带的上游 changeset 摘要，`ci` / `chore` / 版本 bump / merge 等机械提交不列。分类、压缩、翻译和双语镜像沿用该 skill，但不沿用其稳定版 CHANGELOG 输入要求与总量不超过 10 条的限制，区间条目全部列出。

将整理好的文件放在 `release-notes/<version>/changelog.{zh,en}.md`，然后单独上传到两个 bucket 的版本目录和过渡期旧路径（示例版本与上文一致）：

```bash
version=1.0.5-canary.108.2.gabc12345
for target in oss:kimi-code oss-oversea:kimi-code-oversea; do
  for lang in zh en; do
    for dest in "desktop/binaries/${version}" "desktop/${version}"; do
      rclone copyto "release-notes/${version}/changelog.${lang}.md" \
        "${target}/${dest}/changelog.${lang}.md" \
        --header-upload 'Cache-Control: no-cache, max-age=0, must-revalidate' \
        --header-upload 'Content-Type: text/markdown; charset=utf-8'
    done
  done
done
```

`cache-control` 必须是 `no-cache, max-age=0, must-revalidate`，便于后续修订覆盖。上传后用 `rclone cat` 核对两个源站的内容，用 `rclone lsjson --stat --metadata` 核对元数据，再用带 cache-buster 的版本目录 URL 检查边缘；不要依赖缓存中的旧响应判断上传结果。
