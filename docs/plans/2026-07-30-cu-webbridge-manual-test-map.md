# 用户场景测试导图：v2 CLI 内置能力（2026-08-03）

> 只测 `pnpm run dev:cli:v2`，不测 desktop、Kimi Work、v1 客户端或 server REST。
> “内置”指 CLI 在默认 marketplace 中内置 `kimi-cu` / `kimi-webbridge` 两个官方条目；运行时与插件仍从各自 latest 地址安装。

## S1 全新 v2 CLI 用户

- [ ] S1.1 **全新安装 kimi-cu**
  布置：移除 kimi-cu 插件记录和 `/Applications/KimiCU.app`；操作：启动 `pnpm run dev:cli:v2`，在 `/plugins` Official 中安装；预期：下载、App、service、permissions 进度可见，授权完成后显示 ready，新会话可用 Computer Use
- [ ] S1.2 **全新安装 WebBridge**
  布置：移除 WebBridge 插件记录、本地 daemon binary，并确保 daemon 未运行；操作：从 `/plugins` Official 安装；预期：下载 latest binary、启动 daemon、安装 managed plugin，扩展未连接只显示软提示，不阻塞 ready
- [ ] S1.3 **安装后卸载再恢复**
  布置：能力 ready；操作：从 Installed 移除插件，再从 Official 重装；预期：只移除接线，运行时保留，状态变 partial；重装只补插件层并恢复 ready

| 判据 | 可接受结果 |
|---|---|
| v2 可见性 | 两个内置条目只出现在 v2 默认 marketplace |
| 完成态 | 所有必需层为 ok；WebBridge extension 可 missing |
| 卸载边界 | 不删除 App、daemon 或 managed 文件 |

过渡态备忘：TCC 弹窗和浏览器扩展需要用户操作；等待期间显示 partial 不是失败。

## S2 已经通过其他方式装过运行时的用户

- [ ] S2.1 **WebBridge daemon + user skill 已存在**
  布置：daemon 正常运行，并在 `~/.kimi-code/skills/kimi-webbridge` 或 `~/.agents/skills/kimi-webbridge` 放置同名 skill；操作：打开 `/plugins` 并安装内置条目；预期：只补缺失层，明确提示 user skill 会遮蔽 managed plugin；不自动删除任何目录
- [ ] S2.2 **KimiCU App、service、权限都已存在**
  布置：只缺 kimi-cu managed plugin；操作：安装内置条目；预期：只安装插件，不重复下载 App、不重启 service、不再次弹权限框，随后 ready
- [ ] S2.3 **能力已经 ready 时手动重装**
  布置：运行时与 managed plugin 均已就绪；操作：在 Official 再次安装；预期：按 latest 地址覆盖 managed artifacts；WebBridge 不强制重启正在运行的 daemon，新 binary 在下次启动生效

| 判据 | 可接受结果 |
|---|---|
| partial 重试 | 已完成层不重复执行 |
| user skill | 只告警，绝不删除 |
| ready 重装 | 下载 latest，而不是按本地旧版本号分支 |

过渡态备忘：user skill 未手动删除时，capability 可以 ready，但 `/plugins` 必须持续显示遮蔽提示。

## S3 同时使用其他 agent 的用户

- [ ] S3.1 **其他 agent 手配了 kimi-cu MCP**
  布置：其他 agent 工具已有独立 kimi-cu MCP 配置；操作：在 v2 CLI 安装、停用、卸载内置条目；预期：其他 agent 的配置和进程不被修改
- [ ] S3.2 **其他 agent 有 WebBridge skill**
  布置：其他 agent 工具的配置目录（`~/.agent-a`、`~/.agent-b/skills` 等）存在 WebBridge skill；操作：安装或卸载 Kimi Code managed plugin；预期：这些目录内容和时间戳不变

| 判据 | 可接受结果 |
|---|---|
| 文件边界 | 只改 Kimi Code 自己的插件记录与 managed 内容 |
| 共享目录 | `~/.agents/skills` 只读检测，不做删除或覆盖 |

过渡态备忘：不同 agent 同时连接一个运行时不属于本轮端到端测试范围，只检查 Kimi Code 不主动破坏其他配置。

## S4 网络异常或安装被打断的用户

- [ ] S4.1 **下载前断网**
  布置：运行时缺失并断网；操作：安装；预期：错误出现在 `/plugins` 结果中，TUI 不退出；恢复网络后可重试
- [ ] S4.2 **部分层完成后中断**
  布置：让 binary/App 已落地，但 plugin 或 service 步骤失败；操作：重启 v2 CLI 后再次安装；预期：状态准确显示 partial，只继续缺失层
- [ ] S4.3 **Chrome Web Store 不可达**
  布置：daemon 与 plugin ready，但无法访问商店；操作：查看 WebBridge skill 引导；预期：提供离线扩展 zip 和 `chrome://extensions` 手动加载方法，extension missing 不阻塞 ready

| 判据 | 可接受结果 |
|---|---|
| 错误可见 | `install.error` 可读，CLI 不因后台 Promise 退出 |
| 幂等 | 重试不会破坏已完成层 |
| 离线引导 | 无法访问商店时仍有明确人工路径 |

过渡态备忘：下载百分比依赖响应是否提供 `content-length`；没有百分比但步骤名称持续更新不算 bug。

## S5 macOS 权限受限用户

- [ ] S5.1 **拒绝 kimi-cu 权限**
  布置：关闭 Accessibility 或 Screen Recording；操作：安装；预期：App、service、plugin 可完成，状态为 partial，并准确列出缺失权限；授权后重新打开 `/plugins` 转 ready
- [ ] S5.2 **`/Applications` 不可写**
  布置：普通用户或 MDM 限制；操作：安装 kimi-cu；预期：先尝试直接安装，再出现系统管理员授权；最终失败时错误明确且可重试

| 判据 | 可接受结果 |
|---|---|
| 权限探测 | 只读探测不主动弹窗 |
| 权限请求 | 仅安装流程触发，拒绝不伪装 ready |

过渡态备忘：macOS 系统设置修改后可能需要重新打开 `/plugins` 才刷新状态。

## S6 长期使用与被动升级用户

- [ ] S6.1 **WebBridge ready 后重装 latest**
  布置：记录当前 binary 内容或版本与 plugin 更新时间；操作：再次从 Official 安装；预期：latest binary 覆盖落盘、managed plugin upsert，正在运行的 daemon 不被强制重启
- [ ] S6.2 **KimiCU ready 后重装 latest**
  布置：App、service、permissions、plugin 均 ready；操作：再次安装；预期：重新下载 latest App 与 plugin，重新注册 service，已授权权限保持可用

| 判据 | 可接受结果 |
|---|---|
| 升级触发 | 只在用户主动重装时发生，不扫描或比较硬编码旧版本 |
| 版本来源 | 展示值只来自实际 App / daemon / plugin；不使用历史 installer 版本文件 |

过渡态备忘：WebBridge binary 覆盖后，当前 daemon 进程仍可能报告旧运行版本；下次 daemon 启动后才使用新 binary。

## 附录：环境命令

```bash
cd ~/code/kimi-code
pnpm run dev:cli:v2
```

必要时用独立 `KIMI_CODE_HOME` 做破坏性测试，避免污染日常配置；内置条目无需额外启动本地 marketplace server。

## 排除项（本轮不测）

- desktop、Kimi Work、多进程实时同步
- v1 客户端兼容和 server REST API
- 任意历史 guide/plugin 版本号识别、迁移或升级判断
- 自动删除 user skill

问题记录：____（场景号 + 现象 + 期望）
