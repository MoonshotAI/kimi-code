# OAuth 授权完成唤起桌面端：授权服务集成说明

日期：2026-07-30
面向：授权服务（OAuth host）团队
状态：客户端侧已全部就绪（kimi-code `MoonshotAI/kimi-code#2382` 已合并；desktop 客户端随下个版本发布）

## 背景

Kimi Code 桌面端（Electron）的登录走 OAuth device flow：客户端在应用内打开授权页，用户在浏览器完成授权，daemon 轮询拿 token。现状是授权完成后用户要手动切回应用。目标：授权完成后把用户引导回桌面端。

**登录态不经 URL 传递**——token 由 daemon 轮询获得，跳转链接只负责「唤起窗口」，无任何凭证信息，安全风险面最小。

## 客户端已就绪的部分

- **自定义协议**：`kimi-code://`（四平台注册：macOS Info.plist、Windows 运行时注册表、Linux deb desktop file）。当前唯一路径 **`kimi-code://auth/success`**：白名单仅认这一条（scheme/host 大小写无关、path 大小写敏感、拒绝 query/fragment），命中即把主窗口唤到前台；未知 URL 脱敏记日志后丢弃，不聚焦。
- **来源标记**：桌面端打开的授权链接带 `from=kimi_code_desktop`（见下）；CLI / web 的链接不带。
- **身份头**：device flow 三端点（device_authorization / token 轮询 / refresh）现在携带完整 `X-Msh-*` 设备头 + 产品 UA。各端取值：

  | 端 | `X-Msh-Platform` | `User-Agent` |
  |---|---|---|
  | CLI / TUI | `kimi_code_cli` | `kimi-code-cli/<version>` |
  | `kimi web` | `kimi_code_cli` | `kimi-code-cli/<version> (web)` |
  | Desktop（Electron） | `kimi_code_desktop` | `kimi-code-desktop/<version>` |
  | VS Code 扩展 | `kimi_code_vscode` | `kimi-code-vscode/<version>` |

## 需要授权服务配合的事

### 1.（必须）platform 显示名映射

`kimi_code_desktop` 与 `kimi_code_vscode` 是新增 platform 取值。console「登录设备」目前显示「未知设备」——不拒绝（登录与调用均正常），但显示层需要补映射（`kimi_code_desktop` → 桌面端 / Kimi Code Desktop 等展示名）。

### 2. 唤起方案 A（v1，推荐先行）：完成页渲染「打开桌面端」按钮

- 授权页（`authorize_device`）读取 query 参数 **`from`**：
  - `from=kimi_code_desktop` → 授权成功（及失败/取消，见下）时渲染「**打开 Kimi Code 桌面端**」按钮，点击跳 `kimi-code://auth/success`；
  - 无 `from`（CLI / web / 其他）→ 不渲染（这些端没有可唤起的应用）。
- **按钮手动触发，不要页面加载后自动跳**：无用户手势的协议唤起在部分浏览器会被静默拦截，且用户没有预期时弹确认框体验差。
- 浏览器会弹一次系统确认框（「要打开 Kimi Code 吗」），属预期行为；https 页面会显示来源（「https://www.kimi.com 想打开此应用」）并可勾选「始终允许」。
- 未安装桌面端的兜底（探测失焦 → 下载引导）一期不做，二期再议。

### 3. 唤起方案 B（v2，可选增强）：redirect_uri 自动跳转

在 A 之上提供更顺滑的零点击路径：

- 客户端在授权链接上追加 **`redirect_uri`** 参数（桌面端来源时）：`authorize_device?user_code=…&from=kimi_code_desktop&redirect_uri=<urlencoded>`。
- 授权成功后，**不要直接 302 到 `kimi-code://`**，而是 302 到一个 **https 中转页**（如 `https://www.kimi.com/code/handoff?from=kimi_code_desktop`）：
  - 中转页自动尝试 `kimi-code://auth/success`（iframe 或 location 赋值）；
  - 同时渲染「正在打开桌面端……没有反应？点此打开 / 去下载」的兜底 UI。
- 为什么不直跳 scheme：中转页与授权页同源、无需为自定义 scheme 开重定向白名单；且能优雅处理「未安装 app」与「在手机/他端完成授权」的死局。
- 授权服务器只需：识别并接受 `redirect_uri`（https 同源或域名白名单），授权成功后 302 过去。

### 4. wire 变化知会

- OAuth 三端点的 `User-Agent` 从 undici 默认值（`node`）变为产品 UA（见上表，`kimi web` 带 `(web)` 后缀）；同时开始携带六个 `X-Msh-*` 头（含稳定 `X-Msh-Device-Id` 设备指纹）。请确认无基于 UA/头的风控或白名单误伤。

## 对齐点清单（需双方确认后冻结）

1. `from` 参数名与取值（当前：`from=kimi_code_desktop`）。
2. `kimi-code://auth/success` 路径；失败/取消的对称路径（建议 `kimi-code://auth/failure`，客户端侧加白名单一行即可，未做）。
3. 方案 B 的 `redirect_uri` 参数名、中转页地址、白名单范围。
4. platform 显示名映射表（`kimi_code_desktop` / `kimi_code_vscode`）。
