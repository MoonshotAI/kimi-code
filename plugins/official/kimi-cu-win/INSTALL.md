# KimiCU for Windows 安装说明

发布包采用和 macOS KimiCU 类似的安装方式：一个 bootstrap 脚本配合 runtime zip 与插件 zip。

```text
setup_windows.ps1
setup_windows.cmd
kimi-cu-win-runtime.zip
kimi-cu-win-plugin.zip
kimi-cu-win-codex-plugin.zip
kimi-cu-win-claude-plugin.zip
```

## 0. 系统要求

- Windows 10 version 1903 (Build 18362) 或更新版本，推荐 Windows 10 22H2 / Windows 11，x64。
- Windows Server 需要带 Desktop Experience，并在真实交互式用户会话中运行；不支持 Server Core 或 Session 0 服务会话控制桌面。
- Computer Use 期间必须保持桌面已解锁并处于可交互的 `Default` 桌面；锁屏、UAC 等安全桌面或远程会话断开时，runtime 会拒绝 GUI 观察和输入，并提示解锁或重新连接后重试。
- runtime 是已打包的二进制，不要求目标机器安装 Rust、Cargo 或 Visual Studio Build Tools。
- 安装后 KimiCU agent 会自动启动，并在当前用户后续登录时自动运行。企业策略如果禁用桌面自动化、截图或跨权限输入，可能影响截图和真实输入。
- 如果目标应用以管理员权限运行，KimiCU agent 也需要同等权限级别，否则 Windows UIPI 可能阻止输入或 UIA 操作。
- 前台真实输入期间会在每块显示器上显示 KimiCU 正在使用电脑的状态提示和蓝色边缘 glow，并显示 second cursor；显示层使用点击穿透窗口，不拦截发往目标应用的真实鼠标输入。这是可视化过程指示，不改变 MCP 工具能力，也不提高系统要求。
- 正式 CDN 安装会校验 runtime ZIP 的 SHA-256，并要求 `kimi-cu.exe` 具有匹配发布证书且带时间戳的有效 Windows Authenticode 签名。

## 1. 安装 Runtime

一键安装最新 runtime：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Invoke-RestMethod 'https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.ps1' | Invoke-Expression"
```

Git Bash 使用 CMD bootstrap，不依赖 `powershell.exe` 是否在 `PATH`：

```bash
curl -fsSL https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.cmd -o setup_windows.cmd
./setup_windows.cmd
rm -f setup_windows.cmd
```

如果 `setup_windows.ps1` 和 `kimi-cu-win-runtime.zip` 在同一个目录，直接执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup_windows.ps1
```

如果 runtime zip 已经托管在远端地址：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup_windows.ps1 -RuntimeZipUrl "https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-runtime.zip"
```

固定安装某个版本目录：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup_windows.ps1 -Version "0.2.17"
```

默认会安装到：

```text
%LOCALAPPDATA%\KimiCU\kimi-cu.exe
```

安装脚本会立即在后台启动 agent。用户下次登录 Windows 后也会自动拉起，且不会
保留控制台窗口；更新安装会自动替换旧版本的启动配置。

仓库本地构建的 runtime 默认未签名。仅在开发或 CI 临时目录中安装这类产物时，
显式传入 `-AllowUnsignedRuntime`；正式发布安装不应使用该选项。

检查 runtime：

```powershell
& "$env:LOCALAPPDATA\KimiCU\kimi-cu.exe" doctor
```

预期输出包含：

```text
mcp=true
helper=embedded
```

## 2. 检查和安装更新

常驻 KimiCU Agent 会在启动时及每 6 小时检查更新，MCP 启动时也会异步复用同一缓存。
发现新版本后，通知区域会提示一次，控制面板会显示“立即更新”。更新不会静默执行；
点击更新后，现有 Computer Use MCP 连接会关闭，
升级中的工具结果会明确标记为不可在当前会话重试。新版本从下一次 MCP 会话开始生效，
因此更新完成后需要重新连接 KimiCU MCP，或重启当前 Agent 宿主。

控制面板更新不会下载或执行远程脚本。当前已签名 `kimi-cu.exe` 会复制自身到临时目录，
由该副本下载固定版本的 EXE 数据，校验 SHA-256、与当前 runtime 相同的 Authenticode
发布证书及时间戳，再在目标目录暂存并运行 `doctor`。成功后才替换旧 EXE；替换或
Agent 启动失败会恢复旧版本。

命令行可用于诊断更新状态或只验证指定版本，不会改变原有安装命令：

```powershell
& "$env:LOCALAPPDATA\KimiCU\kimi-cu.exe" check-update
& "$env:LOCALAPPDATA\KimiCU\kimi-cu.exe" upgrade "<version>" --dry-run
```

原有 `setup_windows.ps1` / `setup_windows.cmd` 命令仍用于首次安装、手动重装或手动更新；
它们继续下载并校验 runtime ZIP，与控制面板的原生单 EXE 更新链路相互独立。

### 录制包含 Overlay 的演示视频（可选）

Overlay 默认不会进入常规截图或桌面录屏。需要录制演示时，在同一个 PowerShell
环境中设置开关并重启 agent：

```powershell
$env:KIMI_CU_ALLOW_OVERLAY_CAPTURE = "1"
& "$env:LOCALAPPDATA\KimiCU\kimi-cu.exe" restart-agent
```

录制结束后恢复默认排除行为：

```powershell
Remove-Item Env:KIMI_CU_ALLOW_OVERLAY_CAPTURE -ErrorAction SilentlyContinue
& "$env:LOCALAPPDATA\KimiCU\kimi-cu.exe" restart-agent
```

该开关只允许外部桌面捕获看到状态 pill、蓝色边缘 glow、shimmer 和 second cursor；
窗口级 `get_app_state`、点击穿透、真实输入和 MCP 工具语义保持不变。

## 3. 安装插件

Kimi 插件宿主安装或导入：

```text
https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip
```

Codex 本地插件市场安装或导入：

```text
https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-codex-plugin.zip
```

Claude Code 2.1.128+ 直接加载远端插件 ZIP：

```powershell
claude --plugin-url "https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-claude-plugin.zip"
```

也可以下载 ZIP 后通过 `claude --plugin-dir <目录或 ZIP>` 加载。`--plugin-url` 和
`--plugin-dir` 只对当前会话生效；持久安装需要通过 Claude marketplace。

插件不需要手动启动 MCP。Kimi 和 Claude 包会启动：

```text
bin\kimi-cu-mcp.cmd
```

Codex 包中的对应路径是 `plugin\bin\kimi-cu-mcp.cmd`。这些入口复用同一个 wrapper。

这个 wrapper 会自动执行：

```text
%LOCALAPPDATA%\KimiCU\kimi-cu.exe mcp
```

## 4. 使用方式

让 agent 检查或操作 Windows 应用，例如：

```text
列出当前可见的 Windows 桌面应用。
用 Kimi Computer Use for Windows 查看记事本。
点击某个应用的搜索框并输入 hello。
```

当前暴露的工具：

```text
list_apps
launch_app
activate_window
get_app_state
click
type_text
press_key
scroll
set_value
perform_secondary_action
select_text
drag
turn_ended
```

## 注意事项

Windows 上 Electron、浏览器、富文本、拖拽和快捷键等路径通常需要前台真实输入。执行这些操作时，目标窗口可能会被短暂激活，鼠标指针也可能短暂移动；runtime 会显示使用中提示并在操作结束后尽量恢复鼠标位置。
`get_app_state` 不会主动激活窗口；如果目标窗口已最小化，先调用 `activate_window` 恢复并置前，再重试观察。真实输入工具会在执行前自动完成激活和恢复。
用户可按 Esc 停止当前 Computer Use turn 的后续真实输入；正常情况下插件宿主会在 turn 结束时清理停止状态。
多个会话同时操作时，真实输入只允许一个 session 持有；收到 `computer_use_busy` 后仍可继续观察，并在刷新状态后重试输入。MCP 正常关闭会自动释放当前 session。

如果插件提示 runtime 不存在，可以重新运行 `setup_windows.ps1`，也可以在启动插件宿主前设置下面任一环境变量：

```powershell
$env:KIMI_CU_WINDOWS_EXE = 'D:\path\to\kimi-cu.exe'
$env:KIMI_CU_WINDOWS_HOME = 'D:\path\to\KimiCU'
```
