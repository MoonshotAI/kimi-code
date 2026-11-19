# 测试指南

先写出用户或调用方依赖的行为，再选能复现故障、能直接观察结果的入口。「桌面用户看到了回答」要读真实窗口。「引擎重试后完成了原回合」可以从引擎会话验收。选定位置后，再读该目录最近的 AGENTS.md。

## 测试今天写在哪

普通修复优先补到已有覆盖该行为的文件。下表列的是当前仓库入口，路径从仓库根目录算起。

| 要观察的行为 | 现有入口 |
|---|---|
| 一个模块的公开接口、边界输入 | 随模块放在所属包的测试目录，如 [core 的 LLM 测试](../packages/core/test/llm/)。桌面主进程和渲染端分别有 [main](../apps/desktop/tests/main/) 和 [renderer](../apps/desktop/tests/renderer/) 测试。 |
| 真实引擎如何调度工具、压缩历史、结束回合 | 从会话 RPC 发起操作，检查回合结果或下一次模型请求。[首轮对话与追问](../packages/agent-core-v2/test/integration/conversation/first-turn.test.ts)已放在引擎集成目录。已有领域用例见 [agent-core-v2 测试](../packages/agent-core-v2/test/)。 |
| KAP 客户端能调用哪些接口，运行时能读到什么 | 接口形状看 [KAP 契约快照测试](../packages/kap-server/test/apiSurface.snapshot.test.ts)。跨服务端和引擎的行为在 [KAP 场景](scenarios/AGENTS.md)里经 REST、WebSocket 驱动。 |
| 用户在 Electron 窗口中看到了什么、还能做什么 | [Desktop E2E](../apps/desktop/e2e/) 用 Playwright 操作真实窗口。把可见回复、输入恢复或实际文件变化作为验收结果。 |
| TUI 如何响应输入，或 CLI 如何结束 | [TUI 首问](../apps/kimi-code/test/e2e/tui/conversation/first-turn.test.ts)启动 CLI 子进程，在标准输入发送字符和 Enter，通过[虚拟终端](../packages/pi-tui/test/virtual-terminal.ts)读取屏幕。[TUI 测试](../apps/kimi-code/test/tui/)另有控制器和布局用例。 |
| 客户端如何从协议事件还原会话 | 找到负责消费事件的包，在 [app-core](../packages/app-core/test/) 或 [app-client](../packages/app-client/test/) 的相应测试旁补断言。 |

## 计划迁入的目录

以下是目标布局。尖括号代表业务或模块名。引擎会话集成和 TUI 读屏目录已接入 Vitest。Desktop 的新 E2E 目录也已接入 Playwright。其余目标目录仍在规划中。已登记的首轮 smoke 见[受保护清单](protected.yaml)。

```text
packages/<包>/test/unit/<模块>/                   模块单测
apps/<应用>/test/unit/<模块>/                     应用内模块单测
packages/core/test/integration/<领域>/            纯 core 运行时集成
packages/agent-core-v2/test/integration/<领域>/   引擎会话集成
packages/kap-server/test/contract/                KAP 公开契约
tests/kap/<领域>/                                 从外部驱动的 KAP 场景
apps/desktop/test/e2e/<业务>/                     Electron 用户旅程
apps/kimi-code/test/e2e/tui/<业务>/               终端键盘与读屏
apps/kimi-code/test/e2e/tui/pty/                  通过真 PTY 验证宿主终端行为
apps/kimi-code/test/e2e/print/                    无界面 CLI 的输出与退出码
packages/app-core/test/replay/                    KAP 客户端回放
packages/app-client/test/replay/                  渲染端状态回放
```

按用户行为逐条迁移。先列出旧用例的断言，在新入口确认 runner 能枚举并执行相应用例，再核对旧文件里其余行为仍有覆盖。接入一个目录时，在同一改动中更新本指南的现有入口、运行命令和对应 CI 的选测范围。尤其要核对 [Desktop 的 spec 发现配置](../apps/desktop/e2e/playwright.config.ts)和 [Vitest 的项目列表](../vitest.config.ts)。

## 什么时候用 testkit

需要可编排的模型、真实 KAP 会话或隔离工作区时，复用私有包 `@moonshot-ai/testkit`。新使用方在自己的 `devDependencies` 加入 `"@moonshot-ai/testkit": "workspace:^"`。[接入说明](../packages/testkit/README.md)

- **控制模型回复**用 `@moonshot-ai/testkit/model`。例如 `model.script(say('hello'))` 安排主通道的下一次回答。测试中途取消时，用命名挂起点等到请求到达。如果要验证已显示的文字，还要等窗口或屏幕实际出现该文字，再触发取消。[假模型指南](../packages/testkit/docs/model.md) · [桌面端接入示例](../packages/testkit/docs/model.md#在桌面端接入假模型)
- **从 KAP 发起一轮对话**用 `@moonshot-ai/testkit/kap`。现有场景通过 [scenarioFixtures](scenarios/support/scenario.ts) 和 `@moonshot-ai/testkit/vitest` 取得 `kap`、`model`。用 `const { id } = await kap.createSession()` 创建会话，依次执行 `await kap.prompt(id, 'hi')` 和 `await kap.waitIdle(id)`，再从 `await kap.turns(id)` 检查最终回答。要验实时帧，就在发送前订阅 WebSocket，并等到相应帧。[完整可运行用例](scenarios/conversation.test.ts) · [KAP 场景指南](../packages/testkit/docs/kap-scenarios.md)
- **隔离数据和工作区**用 `@moonshot-ai/testkit/fixtures`。文件类场景在临时工作区执行，直接读回磁盘内容验收。[夹具、隔离与快照](../packages/testkit/docs/fixtures.md)

Vitest 夹具收尾时会调用 `model.verify()`，检查未消费的脚本、仍挂起的请求等问题。用例本身还要断言产品结果。手动创建假模型时，在断言后调用 `model.verify()`，并在 `finally` 里 `await model.close()`。

## 编写 Desktop 和 TUI 旅程

- Desktop 新旅程放在 `apps/desktop/test/e2e/<业务>/`。从[桌面夹具](../apps/desktop/e2e/fixtures/app.ts)导入 `testWithProvider` 和 `expect`，用 `provider.script(...)` 编排模型，再用 `app.submit(prompt)` 从窗口发送。夹具在首次启动前配置模型，收尾校验脚本和渲染进程未处理异常。每次 Electron 启动都有独立于宿主的 OS home、Kimi 配置和用户数据；同一旅程内重启复用它们。[双 home 对照用例](../apps/desktop/test/e2e/environment/home-isolation.spec.ts)
- TUI 测试用 Vitest 的 `base.extend<TerminalFixtures>(terminalFixtures)`。夹具已启动真实 CLI、配置好假模型并等到首屏。普通键入用 `await terminal.type(text)`，整段粘贴用 `terminal.paste(text)`，提交用 `terminal.press('Enter')`。普通键入的字符间隔模拟人工输入节奏。动作是否成功由 `waitForText`、`waitForTextGone` 或模型事件判定。屏幕和滚动历史可以分别读取。超时会报告最近输入、最后一屏、stderr 和请求状态。[首问示例](../apps/kimi-code/test/e2e/tui/conversation/first-turn.test.ts) · [夹具自测](../apps/kimi-code/test/e2e/tui/support/terminal-session.test.ts)
- TUI 使用管道和虚拟屏幕。可选客户端配置和 fd 下载在子进程中模拟不可用；CLI 的 Node 进程尝试其他非回环 TCP 连接时会被阻止并在收尾时报错。正常收尾经 CLI 退出，超时才强制清理进程树并报告失败。验证宿主 raw mode 或 shell 恢复需要单独的真 PTY 用例。

## 哪些用例值得成为 L0

L0 表示维护者选择长期保护的一条行为。按入选理由分两类，二者都放在最适合验收该行为的测试层。

| 类别 | 入选标准 | 首批候选 |
|---|---|---|
| **基础冒烟（smoke）** | 从产品默认入口完成最短的核心任务，成功与否能由用户直接观察。用受控模型稳定驱动旅程，断言聚焦这条基础体验。 | 桌面用户在新工作区发出第一问，看到完整回答，运行状态结束。已有 spec 还验证了重启恢复，提名范围只到首轮完成。[Desktop 首轮对话](../apps/desktop/e2e/core-turn.spec.ts) |
| **重大回归（regression）** | 有可追溯的缺陷和修复，能说清用户损失、触发顺序和预期结果。用同一验收在修复前后对照，确认旧版因原故障失败、修复版通过。 | 长对话先遇限流，重试又遇上下文超限，原回合曾直接失败。保护自动压缩后继续完成这一问的行为。[core #4950 修复](https://github.com/MoonshotAI/kimi-code/pull/4950) · [现有引擎用例](../packages/agent-core-v2/test/agent/fullCompaction/fullCompaction.test.ts) |

四条首轮 smoke 已登记，#4950 仍是 regression 候选。新增受保护 smoke 时，在[清单](protected.yaml)登记 ID、项目、文件、行为、来源和负责人，在单条测试标题开头写 `[L0:同一ID]` 并保留 smoke 标签。PR 门禁核对实际通过记录，其他用例通过也无法代替该 ID。[CODEOWNERS](../.github/CODEOWNERS) 指派评审。退役已有 ID 时，先评审清单变更，在该 PR 保留原用例和标记供 base 清单验收，合入后再移除标记或用例。删除或放宽已登记的断言时，请负责人核对将失去的保障。若用例使用 golden（入库的预期数据），更新时一并评审预期差异。

## 从根目录运行现有用例

首轮对话有四条 smoke。引擎检查追问时模型收到的上下文，KAP 检查回复结束前客户端已读到部分文本、结束后实时记录与 REST 一致，TUI 检查键入首问后终端显示回答，Desktop 检查真实窗口可以继续编辑。前三条用 Vitest 的 `smoke` 标签选中，Desktop 沿用 Playwright 的 `smoke` 项目。smoke 的运行分组与 L0 人审分别维护。

```sh
pnpm test:smoke
pnpm exec vitest run --reporter=agent packages/agent-core-v2/test/agent/fullCompaction/fullCompaction.test.ts -t 'compacts and retries when provider context overflow follows an earlier LLM retry'
pnpm --filter kimi-code-app run e2e --no-build --list --project=smoke
pnpm --filter kimi-code-app run e2e --project=smoke
```

第一条命令与 [E2E smoke 工作流](../.github/workflows/e2e-smoke.yml)共用，运行三个 Vitest 项目的 smoke 并构建、启动真实 Electron。新增 Vitest smoke 在对应目录标记 `tags: ['smoke']`；桌面用例在 Playwright 中标记 `tag: '@smoke'`，按标签进入 smoke 项目。CI 关闭重试，失败日志和 Playwright 产物随 job 上传。Desktop 的 `--list` 命令只枚举。仓库级 lint、类型检查和平台验证见[根目录指南](../AGENTS.md#结束前的验证)。

## Desktop 的临时隔离用例

默认 Desktop 运行排除标记为 `@quarantine` 的单条用例。同一文件的其他用例照常运行。当前隔离的九条在基线 `0ee6dff5f` 上用同一 Electron 构建逐条复现，涉及断流恢复、侧聊与压缩、后台命令、失败转录、插话、审批中停止、附件、默认设置和外观。隔离期间，默认运行的绿灯不涵盖这九个场景。

在仓库根目录运行以下命令，分别查看隔离清单或单独执行它们。排查某一条时可再传 spec 文件名或 `--grep`。修复后先在隔离模式下验证原断言，再移除该用例的标签并从默认入口复验。

```sh
pnpm --filter kimi-code-app run e2e --quarantine --no-build --list
pnpm --filter kimi-code-app run e2e:headless --quarantine --retries=0
```

## KAP 录制与客户端回放

[首轮录制](scenarios/replay.test.ts)用真实服务分别捕获初始 REST 页、订阅基线、模型挂起时及回合结束时的 WS 帧和最终 REST 页。[客户端回放](../packages/app-core/test/replay/first-turn.test.ts)离线调用生产 reducer，业务期望由消费者独立维护。运行 `pnpm exec vitest run tests/scenarios/replay.test.ts packages/app-core/test/replay` 验证两端。只有显式运行 `pnpm qa:refresh replay` 才会刷新录制，随后评审数据差异。CI 始终只读。
