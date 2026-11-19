# 测试指南

先写出用户或调用方依赖的行为，再选能复现故障、能直接观察结果的入口。「桌面用户看到了回答」要读真实窗口。「引擎重试后完成了原回合」可以从引擎会话验收。选定位置后，再读该目录最近的 AGENTS.md。

## 测试今天写在哪

普通修复优先补到已有覆盖该行为的文件。下表列的是当前仓库入口，路径从仓库根目录算起。

| 要观察的行为 | 现有入口 |
|---|---|
| 一个模块的公开接口、边界输入 | 随模块放在所属包的测试目录，如 [core 的 LLM 测试](../packages/core/test/llm/)。桌面主进程和渲染端分别有 [main](../apps/desktop/tests/main/) 和 [renderer](../apps/desktop/tests/renderer/) 测试。 |
| 真实引擎如何调度工具、压缩历史、结束回合 | 从会话 RPC 发起操作，检查回合结果或下一次模型请求。新用例用 `testkitAgentFixtures()` 取得由 testkit 模型驱动的 `agent`，用 `model.script(...)` 编排回复，旧的 `mockNextResponse` 只留给存量用例。[testkit 驱动的引擎用例](../packages/agent-core-v2/test/integration/conversation/testkit-model.test.ts) · [首轮对话与追问](../packages/agent-core-v2/test/integration/conversation/first-turn.test.ts) · [agent-core-v2 测试](../packages/agent-core-v2/test/) |
| KAP 客户端能调用哪些接口，运行时能读到什么 | 接口形状看 [KAP 契约测试](../packages/kap-server/test/apiSurface.test.ts)。跨服务端和引擎的行为在 [KAP 场景](scenarios/AGENTS.md)里经 REST、WebSocket 驱动。 |
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

- **在引擎进程内测试**用 agent-core-v2 harness 的 `testkitAgentFixtures()`。它把 testkit 模型的 `model.fetch` 接到引擎真实的 provider 请求链上，不开端口；收尾时先 `verify()` 再释放引擎。和其他层一样，每个请求都会检查消息序列和工具参数。[引擎用例](../packages/agent-core-v2/test/integration/conversation/testkit-model.test.ts)
- **控制模型回复**用 `@moonshot-ai/testkit/model`。例如 `model.script(say('hello'))` 安排主通道的下一次回答。测试中途取消时，用命名挂起点等到请求到达。如果要验证已显示的文字，还要等窗口或屏幕实际出现该文字，再触发取消。[假模型指南](../packages/testkit/docs/model.md) · [桌面端接入示例](../packages/testkit/docs/model.md#在桌面端接入假模型)
- **从 KAP 发起一轮对话**用 `@moonshot-ai/testkit/kap`。现有场景通过 [scenarioFixtures](scenarios/support/scenario.ts) 和 `@moonshot-ai/testkit/vitest` 取得 `kap`、`model`。用 `const { id } = await kap.createSession()` 创建会话，依次执行 `await kap.prompt(id, 'hi')` 和 `await kap.waitIdle(id)`，再从 `await kap.turns(id)` 检查最终回答。要验实时帧，就在发送前订阅 WebSocket，并等到相应帧。[完整可运行用例](scenarios/conversation.test.ts) · [KAP 场景指南](../packages/testkit/docs/kap-scenarios.md)
- **隔离数据和工作区**用 `@moonshot-ai/testkit/fixtures`。文件类场景在临时工作区执行，直接读回磁盘内容验收。[夹具、隔离与快照](../packages/testkit/docs/fixtures.md)

Vitest 夹具收尾时会调用 `model.verify()`，检查未消费的脚本、仍挂起的请求等问题。用例本身还要断言产品结果。手动创建假模型时，在断言后调用 `model.verify()`，并在 `finally` 里 `await model.close()`。

## 编写 Desktop 和 TUI 旅程

- Desktop 新旅程放在 `apps/desktop/test/e2e/<业务>/`。从[桌面夹具](../apps/desktop/e2e/fixtures/app.ts)导入 `testWithProvider` 和 `expect`，用 `provider.script(...)` 编排模型，再用 `app.submit(prompt)` 从窗口发送。夹具在首次启动前配置模型，收尾校验脚本和渲染进程未处理异常。每次 Electron 启动都有独立于宿主的 OS home、Kimi 配置和用户数据；同一旅程内重启复用它们。环境从 testkit 的 `testEnv()` 起步，不继承宿主的模型密钥和代理设置。Kimi 服务地址指向测试主机，两个可选配置接口和 models.dev 目录回 404，目录因此回落到内置快照。Electron 主进程（包括内嵌的 KAP 服务）预加载 testkit 的网络守卫，连接回环以外的地址会被阻止，收尾时报错；渲染进程发出的请求不在守卫范围内。[环境隔离用例](../apps/desktop/test/e2e/environment/home-isolation.spec.ts)
- TUI 测试用 Vitest 的 `base.extend<TerminalFixtures>(terminalFixtures)`。夹具已启动真实 CLI、配置好假模型并等到首屏。普通键入用 `await terminal.type(text)`，整段粘贴用 `terminal.paste(text)`，提交用 `terminal.press('Enter')`。普通键入的字符间隔模拟人工输入节奏。动作是否成功由 `waitForText`、`waitForTextGone` 或模型事件判定。屏幕和滚动历史可以分别读取。超时会报告最近输入、最后一屏、stderr 和请求状态。[首问示例](../apps/kimi-code/test/e2e/tui/conversation/first-turn.test.ts) · [夹具自测](../apps/kimi-code/test/e2e/tui/support/terminal-session.test.ts)
- TUI 和 KAP 子进程都经 testkit 的 `TestProcess` 启动，环境来自 `kimiCliEnv`：Kimi 服务地址指向网络守卫会拦截的测试主机，只有两个已知的可选配置接口和 fd 下载在子进程中回 404，其他服务请求都会记为违例。CLI 的 Node 进程尝试其他非回环 TCP 连接时会被阻止，收尾时报错，被强杀后也能读到记录。TUI 使用管道和虚拟屏幕；正常收尾经 CLI 退出，超时才强制清理进程树并报告失败。验证宿主 raw mode 或 shell 恢复需要单独的真 PTY 用例。这些子进程默认从源码运行 CLI；主 CI 的 `build` 任务构建全部产物后，设置 `TESTKIT_CLI_BUILD=dist` 再跑一遍 TUI 旅程和冷恢复，验证发布包本身。本地先 `pnpm --filter @moonshot-ai/kimi-code run build`，再用同样的变量运行。[进程夹具](../packages/testkit/docs/fixtures.md#启动被测程序的子进程)

## 哪些用例值得成为 L0

L0 表示维护者选择长期保护的一条行为。按入选理由分三类，都放在最适合验收该行为的测试层。

| 类别 | 入选标准 | 首批候选 |
|---|---|---|
| **基础冒烟（smoke）** | 从产品默认入口完成最短的核心任务，成功与否能由用户直接观察。用受控模型稳定驱动旅程，断言聚焦这条基础体验。 | 桌面用户在新工作区发出第一问，看到完整回答，运行状态结束。已有 spec 还验证了重启恢复，提名范围只到首轮完成。[Desktop 首轮对话](../apps/desktop/e2e/core-turn.spec.ts) |
| **重大回归（regression）** | 有可追溯的缺陷和修复，能说清用户损失、触发顺序和预期结果。用同一验收在修复前后对照，确认旧版因原故障失败、修复版通过。 | 长对话先遇限流，重试又遇上下文超限，原回合曾直接失败。保护自动压缩后继续完成这一问的行为。[core #4950 修复](https://github.com/MoonshotAI/kimi-code/pull/4950) · [现有引擎用例](../packages/agent-core-v2/test/agent/fullCompaction/fullCompaction.test.ts) |
| **对外契约（contract）** | 客户端、外部 agent 或旧版本数据依赖的约定：协议文档、录制回放、冷恢复、KAP 与 ACP 共有行为。删掉或放宽它，使用方不会立刻察觉。 | [协议字段检查](../packages/kap-server/test/apiSurface.test.ts)、[首轮录制](scenarios/replay.test.ts)、[冷恢复](scenarios/cold-recovery.test.ts) |

四条首轮 smoke 已登记，regression 和 contract 的候选待人工确认后登记。登记时在[清单](protected.yaml)写明 ID、`kind`、`runner`（`vitest` 或 `playwright`）、项目、文件、行为、来源和负责人，在单条测试标题开头写 `[L0:同一ID]`；smoke 还要保留 smoke 标签，其他两类不需要。`require_smoke` 列出必须各有一条 smoke 的项目。

两个检查核对实际通过记录，其他用例通过也无法代替该 ID：

- **主 CI 的 `L0 protected tests`** 汇总 5 个测试分片各自记录的 Vitest 结果，核对清单里全部 Vitest 条目，不分类别。缺失、跳过、重试后才通过、预期失败、重复 ID 都会失败；没有收到任何结果时同样失败。
- **[E2E smoke 工作流](../.github/workflows/e2e-smoke.yml)** 在 macOS 上运行三个 Vitest 项目的 smoke 和 Electron smoke，核对 smoke 条目。

两个检查都会并入 PR base 版本的清单和 `require_smoke`，所以在同一个 PR 里删掉用例和清单条目、或者去掉某个项目的 smoke 要求，都会失败。Playwright 条目只能是 smoke，因为只有 Electron smoke 是必过检查。主 CI 的检查只看 L0 结果，其他测试的失败由测试分片报告。[CODEOWNERS](../.github/CODEOWNERS) 指派评审。退役已有 ID 时，先评审清单变更，在该 PR 保留原用例和标记供 base 清单验收，合入后再移除标记或用例。删除或放宽已登记的断言时，请负责人核对将失去的保障。若用例使用 golden（入库的预期数据），更新时一并评审预期差异。[门禁实现](../scripts/protected-smoke.ts)

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

默认 Desktop 运行排除标记为 `@quarantine` 的单条用例。同一文件的其他用例照常运行。[Desktop E2E 工作流](../.github/workflows/desktop-e2e.yml)是可选检查，不阻断合并：改动桌面端或其依赖的 PR 上，只改了 spec 时跑改动的 spec，否则跑全部旅程；合入 main 后跑全部；每晚另外不重试地跑一次隔离用例，结果只作参考。当前隔离的九条在基线 `0ee6dff5f` 上用同一 Electron 构建逐条复现，涉及断流恢复、侧聊与压缩、后台命令、失败转录、插话、审批中停止、附件、默认设置和外观。隔离期间，默认运行的绿灯不涵盖这九个场景。

在仓库根目录运行以下命令，分别查看隔离清单或单独执行它们。排查某一条时可再传 spec 文件名或 `--grep`。修复后先在隔离模式下验证原断言，再移除该用例的标签并从默认入口复验。

```sh
pnpm --filter kimi-code-app run e2e --quarantine --no-build --list
pnpm --filter kimi-code-app run e2e:headless --quarantine --retries=0
```

## KAP 录制与客户端回放

[首轮录制](scenarios/replay.test.ts)用真实服务分别捕获初始 REST 页、订阅基线、模型挂起时及回合结束时的 WS 帧和最终 REST 页。[客户端回放](../packages/app-core/test/replay/first-turn.test.ts)离线调用生产 reducer，业务期望由消费者独立维护。录制、读取和回放都用 testkit 的 `KapRecorder`、`readKapRecording` 和 `replayKapRecording`，见 [KAP 场景指南](../packages/testkit/docs/kap-scenarios.md#录制协议帧给客户端回放)。运行 `pnpm exec vitest run tests/scenarios/replay.test.ts packages/app-core/test/replay` 验证两端。只有显式运行 `pnpm qa:refresh replay` 才会刷新录制，随后评审数据差异。CI 始终只读。

## 冷恢复、协议和规模门禁

从根目录运行 `pnpm qa:layers` 验证已有协议快照、回放、历史数据、KAP/ACP 共有行为及客户端分页预算。[分层检查工作流](../.github/workflows/layered-qa.yml)在修改这些测试基建的 PR、夜间和手动触发时，均在 Linux、macOS 和 Windows 上运行。冷恢复使用[已发布 CLI 写出的原始格式](scenarios/fixtures/released-2.6.3/README.md)；宿主已经看到回合结束时，持久化写入仍可能进行中。

- [协议字段检查](../packages/kap-server/test/apiSurface.test.ts)重新读取真实服务的 OpenAPI 和 AsyncAPI，与[入库文档](../packages/kap-server/schema/)比较。评审时看 [contract.txt](../packages/kap-server/schema/contract.txt)：一行一个字段，多处共用的结构只列一次。有差异时，检查会列出每个变化，并按方向分成破坏、非破坏和未分类三类，例如请求新增必填字段属于破坏，响应新增字段属于非破坏。测试宿主版本固定以隔离包版本变更，KAP 协议版本取实际值。显式更新用 `pnpm qa:refresh schema`，它同时重写两份文档和摘要。同一文件还用契约哈希钉住 `HOST_API_LEVEL`：字段、操作或消息变化后哈希改变，测试失败，由人判断新客户端连接旧版远程宿主是否会出错，需要时升级级别，再更新文件里的哈希；只改描述不影响哈希。内部调试路由不属于契约，单独列出。[契约工具](../packages/testkit/src/contract/)
- [能力表](scenarios/capabilities/conversation.json)登记 KAP 与 ACP 实际公布的字段。共有首轮用真实协议对照相同提问和回答，再核对各自的结束信号。其他单侧字段仍由各自协议维护；能力表的两个传输字段集合可以不同。[对照入口](../packages/acp-server/test/kap-parity.test.ts)
- PR 中客户端分页用 240 个会话回合，验证并发加载每个旧页只读一次。另用 `pnpm qa:history-perf` 在 Electron 测 240 条界面消息（120 轮问答），以 1280×900 窗口比较全量渲染和窗口化渲染。全量基线应挂载 240 条，窗口化初始和滚动挂载均以 32 条为上限。同一工作流在 macos-15 上对交替顺序的三对样本比较打开耗时和 JS 堆增长中位数，并保留环境与原始数据。同一提交的相对预算可以检出窗口化失效；跨版本共同变慢需要对照留存的历史产物。

## 改动行的变异测试

`pnpm qa:mutation` 检验「这次改动的代码出错时，有没有测试会发现」。它只看与 `origin/main` 分叉点之后、已经提交的改动（`--base` 可换比较对象），并且只看各包 `src` 下、所在包有 Vitest 配置的 TS/JS 文件。脚本在系统临时目录另建一个 git worktree，离线安装依赖后逐个包运行 Stryker，只跑引用了被改文件的测试，当前工作区不会被改动。存活的变异体、没有相关测试覆盖的行，以及没能运行的包和原因，写进 `.tmp/mutation/summary.md`，同目录还有每个包的 HTML 报告。模块级常量这类静态变异体要重跑整包测试，默认跳过，加 `--include-static` 才会测。

结果是评审信息，不是门禁。[变异测试工作流](../.github/workflows/mutation.yml)在改动包源码的 PR 上运行，把摘要写进任务摘要，不是必过检查。Stryker 在单个 worker 线程里跑 Vitest，改 `HOME`、工作目录这类进程级状态的测试在那里会失败；这样的包在变异前就停下，摘要里列出失败的用例。
