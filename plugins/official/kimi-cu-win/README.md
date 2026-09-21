# Kimi Computer Use Windows 插件

这个插件让 agent 通过已安装的 Windows native runtime 观察和操作本机 GUI 应用。

插件本身是薄壳：它不会内置 runtime，只会启动本机的：

```text
%LOCALAPPDATA%\KimiCU\kimi-cu.exe mcp
```

## 系统要求

- Windows 10 version 1903 (Build 18362) 或更新版本，推荐 Windows 10 22H2 / Windows 11，x64。
- 需要真实交互式桌面会话；Windows Server 需使用 Desktop Experience。
- 使用时必须保持桌面已解锁并处于可交互的 `Default` 桌面；锁屏、UAC 等安全桌面或远程会话断开时，runtime 会拒绝 GUI 观察和输入，并提示解锁或重新连接后重试。
- runtime 是已打包的二进制，不要求目标机器安装 Rust、Cargo 或 Visual Studio Build Tools。
- 企业策略如果禁用桌面自动化、截图或跨权限输入，可能影响截图和真实输入。
- 前台真实输入期间会显示 KimiCU 正在使用电脑的状态提示、蓝色边缘 glow 和 second cursor；这是可视化过程指示，不改变工具能力或系统要求。
- Overlay 默认排除在截图和桌面录屏之外；演示录制可在启动 agent 前设置 `KIMI_CU_ALLOW_OVERLAY_CAPTURE=1`，不会改变窗口级 `get_app_state` 或真实输入语义。

## 前置条件：先安装 runtime

一键安装最新 runtime：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Invoke-RestMethod 'https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.ps1' | Invoke-Expression"
```

Git Bash 使用 CMD bootstrap：

```bash
curl -fsSL https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.cmd -o setup_windows.cmd
./setup_windows.cmd
rm -f setup_windows.cmd
```

从 release 包里安装：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup_windows.ps1
```

或者指定远端 runtime zip：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup_windows.ps1 -RuntimeZipUrl "https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-runtime.zip"
```

安装完成后，runtime 默认位于：

```text
%LOCALAPPDATA%\KimiCU\kimi-cu.exe
```

然后在插件宿主里导入或安装：

```text
https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip
```

## 工具

```text
list_apps / launch_app / activate_window / get_app_state / click / type_text / press_key / scroll
set_value / perform_secondary_action / select_text / drag / turn_ended
```

`get_app_state` 支持 `mode:"full"`、`mode:"image"`、`mode:"ax"`、`mode:"text"` 四种模式。
其中 `text` 返回轻量 `visible_text`，适合 Electron/Web 消息列表或滚动后只需要确认文本的场景；
`all` 不再是有效模式。`get_app_state` 需要在 `pid`、`app`、`window_id` 中只传一个目标。
`get_app_state` 是被动观察；最小化窗口需要先用 `activate_window` 恢复并置前，再重试观察。
`click` 和 `scroll` 需要 `snapshot_id`，并且只能使用 `index` 或 `x`/`y` 其中一种目标形态。

Windows 上 Electron/Web/飞书等应用优先走真实前台输入；UIA 主要用于观察、元素定位和
显式原生控件语义工具。`click(index)` 使用 UIA 定位矩形，但实际点击仍走真实鼠标输入。
`type_text(index)` 会在清除前拒绝不可编辑目标；`submit:true` 仅在文本验证为 `matched` 时发送 Enter，否则返回 `submitted:false` 和跳过原因。`scroll` 返回 `movement_evidence`，便于判断滚动是否真的生效。
用户按 Esc 会停止当前 Computer Use turn 的后续真实输入；模型自己调用 `press_key("Escape")` 不会误触发停止。
`turn_ended` 只用于隐藏 usage/second cursor overlay 并清理 Esc 停止状态，不操作目标应用。
真实输入被其他 session 占用时会返回 `computer_use_busy` 和 `retryable=true`；只读观察仍可使用，MCP 正常 EOF/shutdown 会自动释放当前 session。
