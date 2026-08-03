---
name: kimi-cu
description: |
  macOS Computer Use：操作本机桌面 app。当用户要求点击、输入、滚动、拖拽、读取某个 app 的界面内容或截图，说「帮我点一下 X」「在 Y 里输入」「看看 Z app 什么状态」「列一下打开的 app」，或任何需要在 macOS 图形界面上代替用户动手的请求时，使用本 skill。所有操作后台执行，不抢用户鼠标、不切换前台。
---

# kimi-cu — macOS 后台 GUI 操作

后台读取无障碍（AX）树 + 截图感知界面，后台注入事件完成操作，用户的鼠标、键盘、前台焦点全程不受影响。各工具的参数细节以工具自身的 schema 为准，本文只讲跨工具的工作流和守则。

## 工作流

1. `list_apps` 找到目标 app。
2. `get_app_state` 获取无障碍树 + 截图，这是后续操作的状态来源：树节点的 **index** 供 `click` / `set_value` / `perform_secondary_action` / `select_text` 直接引用；**截图像素坐标**供 `click` / `scroll` / `drag` 使用（工具自动换算到真实窗口）。需要低上下文观察时用 `mode:"image"` 只取截图、`mode:"ax"` 只取 AX 文本；只关心部分元素时加 `ax_filter`。
3. 执行操作。
4. 重要操作后再次 `get_app_state` 验证界面达到预期。界面状态以工具返回为准，不要凭空断言成功。

读取界面、拿截图、取坐标都必须使用 MCP 的 `get_app_state`。不要通过 shell 跑 `kimi-cu shot` / `app-state` / `windows` 来替代 MCP；这些 CLI 不会刷新 MCP 快照缓存，用它们得到的坐标/index 不能作为后续 MCP 操作依据。

界面一旦变化，旧快照的 index 和坐标即失效，必须重新 `get_app_state`；找不到目标元素时，先 `scroll` 让它进入可视区域再重新获取。

## 用法偏好

- 输入普通表单优先 `set_value`（原子、写后校验；Electron/Web 文本框走无前台后台替换路径：先清空再写入，目标窗口被全覆盖时自动改用 AX 聚焦 + 编辑命令清空 + AX 直写兜底，无需露出窗口、绝不把目标 app 拉前台）；聊天框、富文本、Electron/Web 输入区仍优先使用 `type_text`，因为它能显式控制聚焦、清空和发送。`type_text` 可传可选 `index` 或截图坐标 `x/y` 先聚焦目标再输入：内部走真实后台鼠标点击建立渲染层焦点——这是 Electron/Web 输入区能收到键盘输入的前提。**聚焦输入框请用 `type_text` 的 `index`，不要用 `click(index)`**（后者走 AXPress，只设 AX 焦点，渲染层未聚焦，打字会落空）。都不传 `index/x/y` 时，`type_text` 只向当前焦点注入。
- 列表重排、删除项等优先 `perform_secondary_action` 调用元素自带动作，`drag` 是最后手段。
- **右键菜单 / 上下文菜单**：优先 `perform_secondary_action(index, action:"AXShowMenu")`——原生 app 与 Electron/Web 通常都可靠。`click(mouse_button:"right")` 是合成真实右键，**只对原生 app 有效，Electron/Web 会忽略**，这类应用别用右键 `click` 弹菜单。
- **滚动**：原生滚动区/列表优先 `scroll(index, dy)`（按元素 AX 滚动，整页粒度，dy>0 上）；普通页面用 `scroll(x, y, dy)` 截图坐标。

## 安全守则

1. 删除、发送、提交、付款等不可逆操作，执行前向用户复述将做的事并获得确认。
2. 不要用 AppleScript / cliclick 等手段绕过设计不变量（永不移动真实鼠标、永不切换前台）。
3. 截图中出现密码、银行等敏感内容时，仅完成用户明确要求的操作，不读取或复述无关信息。

## 排障（工具调用失败时）

KimiCU 的权限由 launchd 后台服务持有并在服务内执行操作，agent 进程不需要也不会有这些权限。因此**不要用 `kimi-cu doctor` 判断权限**——它检查的是调用者进程，从你这里跑必然显示 ❌，不代表服务故障。

按顺序排查（Bash）：

```bash
ls /Applications/KimiCU.app/Contents/MacOS/kimi-cu                # 1) app 是否存在
/Applications/KimiCU.app/Contents/MacOS/kimi-cu service-status    # 2) 服务是否注册运行
/Applications/KimiCU.app/Contents/MacOS/kimi-cu xpc-ping          # 3) 权限判定以这条为准
# 正常输出：permissionStatus: accessibility=true screenRecording=true
```

- **app 不存在** → 告知用户：KimiCU.app 未安装，请运行以下命令安装（或经用户同意后代为执行）：
  ```bash
  curl -fsSL https://cdn.kimi.com/kimi-computer-use/latest/setup_macos.sh | bash
  ```
- **服务未运行 / xpc-ping 不通** → `/Applications/KimiCU.app/Contents/MacOS/kimi-cu install`
- **权限为 false，或截图全黑/树为空** → `/Applications/KimiCU.app/Contents/MacOS/kimi-cu request-permissions --ax --screen`，并告知用户去「系统设置 → 隐私与安全性」打开 KimiCU 的「辅助功能」「屏幕录制」开关（系统要求必须用户手点），完成后直接重试即可。

CLI 仅用于以上排障，正常操作一律走 MCP 工具；尤其不要用 `kimi-cu shot` 做日常截图观察。

## 版本更新

工具结果末尾若出现「KimiCU 有新版本」提示，请转告用户：在终端运行 `kimi-cu upgrade` 即可更新到最新版（经用户同意后也可代为执行）。
