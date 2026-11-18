# Preview 体验包

Preview 用于把尚未合入 main 的完整功能交给指定同事测试，不需要维护新的 dev / alpha 发布分支。构建目标为 macOS Apple Silicon 和 Windows x64；构建成功不代表已经通过对应平台的人工验收。

## 构建与分发

1. 提交并推送需要体验的分支；该分支必须包含 Preview 打包支持。
2. 在 Actions → Desktop build → Run workflow 选择该分支，开启 `preview`，保持 `canary` 关闭。macOS 签名、公证固定开启，无需选择。
3. 构建会执行完整桌面端构建，包含主进程、预加载脚本、原生模块和界面；macOS 沿用现有 Developer ID 签名与 Apple 公证。Windows 沿用现有签名设置，不额外配置代码签名证书。
4. 构建成功后，点击运行摘要里的 `Download DMG (darwin-arm64)`，或在 Artifacts 点击 `KimiCodePreview-<version>-mac-arm64.dmg`，直接下载 DMG 并发给同事，不需要先下载和解压 ZIP。Artifact 默认保留 7 天，可以在触发时调整；下载需要登录有仓库读取权限的 GitHub 账号。

Windows 安装包从运行摘要里的 `Download EXE (win32-x64)` 下载，或在 Artifacts 选择 `KimiCodePreview-<version>-win-x64.exe`。运行安装程序后使用 `Kimi Code Preview`，无需覆盖正式版。未配置 Windows 代码签名证书的构建可能触发 SmartScreen 提醒，分发前应告知测试者来源和对应源码提交，不要求关闭系统安全保护。

Preview 只上传原始 DMG / EXE，不再额外上传整组 ZIP。直下载的 Artifact 使用安装包原文件名，包含 Preview 版本号，不受 `upload-artifact-prefix` 影响；通道、分支和源码提交可在运行标题及摘要中查看。此方式使用 `actions/upload-artifact@v7` 的 `archive: false`，不改动安装包内容。

正式版和 Canary 的 macOS 构建也提供 DMG 直下载，同时保留包含 ZIP、更新元数据等文件的发布包，供现有发布流程使用。`upload-artifact-prefix` 只影响这些发布包：默认带构建类型和分支名，Canary 为 `kimi-code-canary-<分支名>`，普通手动构建为 `kimi-code-<分支名>`，正式发版调用仍为 `kimi-code-app`；平台后缀自动追加。分支名中除英文字母、数字、点、下划线和连字符外的字符会替换为连字符，最多保留 160 个字符，替换后为空时使用 `ref`；手动填写前缀可覆盖自动命名。

也可以使用已登录且有仓库权限的 GitHub CLI：

```bash
gh workflow run desktop-build.yml \
  --repo MoonshotAI/kimi-code-app \
  --ref <已推送的功能分支> \
  -f preview=true -f canary=false
```

版本格式为 `<base>-preview.<run_number>.<run_attempt>.g<short_sha>`，Actions 运行摘要记录完整源码提交。重新运行也有独立版本号。安装包名以 `KimiCodePreview-` 开头。

此流程只上传构建产物，不创建 GitHub Release、不上传 CDN，也不改变正式版或 Canary 的更新渠道。`preview` 和 `canary` 同时开启会在打包前报错。

CI 中所有 macOS 构建（正式版、Canary、Preview 和普通手动构建）均固定执行 Developer ID 签名与 Apple 公证，不再提供 `sign-macos` 参数；命令行触发时也不要传入该旧参数。上传前分别解开 DMG 和 ZIP，检查其中应用的 Developer ID 签名、随包公证票据及 Gatekeeper 评估；证书缺失、安装包缺失、签名无效、公证缺失、校验或上传失败都会令构建失败，阻止后续发布，不忽略错误。Windows、Linux 及本地打包的签名设置不变。

运行标题包含通道与分支，例如 `Build Preview · qer/screenshot-annotation`。主要步骤为 `Prepare build`、`Build installers` 和 `Upload DMG`；非 Preview 构建还执行 `Upload release bundle`，`Publish GitHub prerelease` 仅在 Canary 构建时执行。Workflow 文件名仍为 `desktop-build.yml`；应用内触发入口已随 Canary 胶囊清理移除，仅保留命令行与 Actions 页面手动触发。

## 安装与隔离范围

- 应用名 `Kimi Code Preview`，应用标识 `com.kimi.code.desktop.preview`，可以与正式版及 Canary 并存；不同功能的 Preview 会替换同一个 Preview 应用。
- 图标使用绿色机器人，与正式版蓝色、Canary 黄色区分；保留原构图和浅色、深色底板。安装图标与 Dock 图标一致，不嵌入正式版的 Tahoe 图标目录。资源从同一套品牌源文件生成；单独重建 Canary 和 Preview 图标使用 `pnpm build:icons --channels-only`，不改正式版图标或界面组件。
- Electron 配置、窗口状态和缓存使用独立的 `Kimi Code Preview` 用户目录，不导入正式版设置。
- 不注册 `kimi-code://`，不抢正式版的登录回调；浏览器授权完成后可手动返回 Preview。
- 不初始化任何自动更新器，也不内置更新地址；新一轮测试需要手动安装新包。
- 登录、会话及工作区仍通过 `~/.kimi-code` 与其他版本共享。Preview 不是数据沙箱，操作真实会话和项目会改变共享数据。
- macOS 截屏等系统权限按独立应用身份申请，第一次使用可能需要重新授权；Windows 不显示 macOS 的屏幕录制权限引导。
- Windows 安装图标、任务栏身份和重新启动入口与正式版分开；绿色图标从同一份 Preview 品牌源文件生成。

Windows 截图的验证范围与待验收项见 [Windows 截图验收](./screenshot-windows.md)。

## 两个独立 PR 尚未合入时

功能 PR 和 Preview 打包 PR 分别以 main 为基础。在临时打包分支组合两者，再对该分支触发上述构建。无需合入 main；临时分支只用于打包，不反向混入两个 PR。

