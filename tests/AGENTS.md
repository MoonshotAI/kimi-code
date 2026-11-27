# 测试指南

新的 [E2E 工作流](../.github/workflows/e2e.yml)运行 TUI、Web、Desktop 和 ACP 场景：每次合并到 main 都跑，PR 上按需跑（规则见 `tests/e2e/AGENTS.md`）。旧的 Desktop E2E 和 Layered QA 工作流仅手动触发。主 CI 的构建任务用 CLI 构建产物运行[服务端重启重连用例](../packages/app-core/test/reconnect/server-restart.test.ts)。旧的 TUI 和 KAP 子进程旅程步骤暂停。测试分片排除 `apps/kimi-code/test/e2e/tui/` 和 `packages/app-core/test/reconnect/`。`packages/kap-server/test/` 和 `tests/scenarios/` 仍在主 CI 自动运行。PR 上的测试分片只跑改动沿工作区依赖波及的包，以及 `scripts/select-vitest-targets.mjs` 里登记的跨包读取；推送到 main、release 和手动触发 CI 时跑全量。测试跨包读取另一个包的文件、又没在 `package.json` 里依赖它时，要登记到该脚本的 `UNDECLARED_READS`。

先写出用户或调用方依赖的行为，再选能复现故障、能直接观察结果的入口。「桌面用户看到了回答」要读真实窗口。「引擎重试后完成了原回合」可以从引擎会话验收。选定位置后，再读该目录最近的 AGENTS.md。

## 测试今天写在哪

回归用例优先补到已有的同层测试文件。用户通过窗口、终端或 ACP 编辑器操作的端到端场景写在 [`tests/e2e`](e2e/AGENTS.md)，也在这里补旧旅程缺失的断言。`apps/desktop/e2e/` 和 `apps/kimi-code/test/e2e/tui/` 是待迁移的旧目录，只为迁移或移除已有用例而改。迁移时保留原用例覆盖的行为，并使用新 E2E 的驱动。`pnpm lint` 里的 `scripts/checks/legacy-e2e.mjs` 按文件冻结这两个目录的用例数，新增会失败。

| 要观察的行为 | 现有入口 |
|---|---|
| 一个模块的公开接口、边界输入 | 随模块放在所属包的测试目录，如 [core 的 LLM 测试](../packages/core/test/llm/)。桌面主进程和渲染端分别有 [main](../apps/desktop/tests/main/) 和 [renderer](../apps/desktop/tests/renderer/) 测试。 |
| 真实引擎如何调度工具、压缩历史、结束回合 | 从会话 RPC 发起操作，检查回合结果或下一次模型请求。新用例用 `testkitAgentFixtures()` 取得由 testkit 模型驱动的 `agent`，用 `model.script(...)` 编排回复，旧的 `mockNextResponse` 只留给存量用例。[testkit 驱动的引擎用例](../packages/agent-core-v2/test/integration/conversation/testkit-model.test.ts) · [首轮对话与追问](../packages/agent-core-v2/test/integration/conversation/first-turn.test.ts) · [agent-core-v2 测试](../packages/agent-core-v2/test/) |
| KAP 客户端能调用哪些接口，运行时能读到什么 | 接口形状看 [KAP 契约测试](../packages/kap-server/test/apiSurface.test.ts)。跨服务端和引擎的行为在 [KAP 场景](scenarios/AGENTS.md)里经 REST、WebSocket 驱动。 |
| 用户在 TUI、Web、Desktop 或 ACP 编辑器里看到了什么、还能做什么 | [E2E 场景](e2e/AGENTS.md)驱动真实产品入口。终端行为可用 [TUI 专属场景](e2e/scenarios/terminal/restores-terminal-modes-on-exit.spec.ts)验证。 |
| 无界面 CLI 的输出和退出码 | [CLI 测试](../apps/kimi-code/test/cli/)验证命令行入口。 |
| 客户端如何从协议事件还原会话 | 找到负责消费事件的包，在 [app-core](../packages/app-core/test/) 或 [app-client](../packages/app-client/test/) 的相应测试旁补断言。 |

## 计划中的目录布局

端到端场景已经接入 [`tests/e2e`](e2e/AGENTS.md)。下列目录是后续迁移的目标布局，当前写新用例以入口表和各包指南为准。

```text
packages/<包>/test/unit/<模块>/                   模块单测
apps/<应用>/test/unit/<模块>/                     应用内模块单测
packages/core/test/integration/<领域>/            纯 core 运行时集成
packages/agent-core-v2/test/integration/<领域>/   引擎会话集成
packages/kap-server/test/contract/                KAP 公开契约
tests/kap/<领域>/                                 从外部驱动的 KAP 场景
tests/e2e/scenarios/<业务>/                       新 E2E：各个面共用的用户场景
packages/app-core/test/replay/                    KAP 客户端回放
packages/app-client/test/replay/                  渲染端状态回放
```

迁移用例时，先列出原用例覆盖的行为，再用新 runner 枚举并运行相应用例，确认移除旧用例后这些行为仍有覆盖。接入一个目录时，在同一改动中更新本指南的入口、运行命令和 CI 选测范围。

## 什么时候用 testkit

需要可编排的模型、真实 KAP 会话或隔离工作区时，复用私有包 `@moonshot-ai/testkit`。新使用方在自己的 `devDependencies` 加入 `"@moonshot-ai/testkit": "workspace:^"`。[接入说明](../packages/testkit/README.md)

需要假模型时只用 testkit。`mockNextResponse`、`createMockProvider` 一类的引擎 harness 函数和手写的模型流只留给存量用例；只测 loop core、只需要一个 requester 的单元测试可以继续用 `createMockProviderRequester`。这些 harness 函数的回复也由 testkit 模型产生，每个用例结束时都会对账：发出了没写剧本的请求、写了剧本却没被请求、消息序列不合法（例如连续两条相同的用户消息），用例都会失败。testkit 模型还默认检查 prompt 缓存前缀：主 agent 或压缩请求没有延续上一个主请求、又没有声明，用例同样失败。撤销、清空上下文这类有意改写历史的用例，用 `ctx.expectCacheBreak(原因, { at: 'history' })` 写明原因，直接用 testkit 模型时写 `model.expectCacheBreak(...)`。规则见 [testkit README](../packages/testkit/README.md#prompt-cache)。引擎在 loop 启动时就固定了请求里的工具列表，之后注册的工具和经 `select_tools` 加载的工具只通过对话传给模型，所以 harness 默认不检查「调用的工具是否在请求里提供过」；需要时用 `testAgent({ scriptedModelChecks })` 打开这项检查，故意构造重复消息的用例也用它关掉消息检查。测试也不 import 别的包的测试代码，例如 `packages/agent-core-v2/test/harness`；确实要直接驱动 harness agent 的用例列在 `scripts/checks/test-doubles.mjs` 的 `ENGINE_HARNESS_IMPORTERS` 里，并写明原因。会话标题和反馈这类 Kimi 托管服务用 testkit 的假 Kimi 服务（`@moonshot-ai/testkit/services`），不要手写 fetch 桩或 HTTP 网关；只有 `packages/oauth/test` 里托管服务客户端自己的协议测试例外。MCP 服务用 testkit 的 `fakeMcpServer()`（stdio）和 `startFakeMcpHttpServer()`（可流式 HTTP 或 SSE），不要用 SDK 自己搭服务，也不要按路径引用别的包测试目录里的服务脚本，用法见 [testkit 夹具文档](../packages/testkit/docs/fixtures.md#挂一个假的-mcp-服务)。`pnpm lint` 里的 `scripts/checks/test-doubles.mjs` 按文件冻结其中能识别的写法：引擎 harness 的这些函数、手写的 OpenAI 流、手写的 Kimi 服务线协议、自己搭的 MCP 服务和跨包 import 测试代码，新增会失败；其余的靠评审。

- **在引擎进程内测试**用 agent-core-v2 harness 的 `testkitAgentFixtures()`。它把 testkit 模型的 `model.fetch` 接到引擎真实的 provider 请求链上，不开端口；收尾时先 `verify()` 再释放引擎。和其他层一样，每个请求都会检查消息序列和工具参数。[引擎用例](../packages/agent-core-v2/test/integration/conversation/testkit-model.test.ts)
- **控制模型回复**用 `@moonshot-ai/testkit/model`。例如 `model.script(say('hello'))` 安排主通道的下一次回答。测试中途取消时，用命名挂起点等到请求到达。如果要验证已显示的文字，还要等窗口或屏幕实际出现该文字，再触发取消。[假模型指南](../packages/testkit/docs/model.md) · [桌面端接入示例](../packages/testkit/docs/model.md#在桌面端接入假模型)
- **从 KAP 发起一轮对话**用 `@moonshot-ai/testkit/kap`。现有场景通过 [scenarioFixtures](scenarios/support/scenario.ts) 和 `@moonshot-ai/testkit/vitest` 取得 `kap`、`model`。用 `const { id } = await kap.createSession()` 创建会话，依次执行 `await kap.prompt(id, 'hi')` 和 `await kap.waitIdle(id)`，再从 `await kap.turns(id)` 检查最终回答。要验实时帧，就在发送前订阅 WebSocket，并等到相应帧。[完整可运行用例](scenarios/conversation.test.ts) · [KAP 场景指南](../packages/testkit/docs/kap-scenarios.md)
- **隔离数据和工作区**用 `@moonshot-ai/testkit/fixtures`。文件类场景在临时工作区执行，直接读回磁盘内容验收。[夹具、隔离与快照](../packages/testkit/docs/fixtures.md)
- **测试不连外网。** agent-core-v2、kap-server、node-sdk 和 `tests/scenarios` 的 setup 打开了 testkit 的网络守卫，用例连接回环以外的地址就会失败，即使它自己捕获了连接错误。需要一个连不上的服务地址时，用回环地址上没有监听的端口，例如 `https://127.0.0.1:9`；不要用 `example.test` 这类域名，它们仍会发出 DNS 查询，也会被守卫拦下。[网络守卫](../packages/testkit/docs/fixtures.md)

Vitest 夹具收尾时会调用 `model.verify()`，检查未消费的脚本、仍挂起的请求等问题。用例本身还要断言产品结果。手动创建假模型时，在断言后调用 `model.verify()`，并在 `finally` 里 `await model.close()`。

## KAP 录制与客户端回放

[首轮录制](scenarios/replay.test.ts)用真实服务分别捕获初始 REST 页、订阅基线、模型挂起时及回合结束时的 WS 帧和最终 REST 页，另有一个在回合中途订阅的客户端单独成一路流。[客户端回放](../packages/app-core/test/replay/first-turn.test.ts)离线调用生产 reducer，检查中途订阅的客户端得到同一份最终视图，重复帧和不认识的帧类型不改变视图；业务期望由消费者独立维护。录制、读取和回放都用 testkit 的 `KapRecorder`、`readKapRecording` 和 `replayKapRecording`，见 [KAP 场景指南](../packages/testkit/docs/kap-scenarios.md#录制协议帧给客户端回放)。运行 `pnpm exec vitest run tests/scenarios/replay.test.ts packages/app-core/test/replay` 验证两端。只有显式运行 `pnpm qa:refresh replay` 才会刷新录制，随后评审数据差异。CI 始终只读。[重启后自动重连](../packages/app-core/test/reconnect/server-restart.test.ts)让生产客户端连着 CLI 子进程，强杀服务端并在同一端口重启后，检查客户端自行重连、读回同一份历史并跟上下一轮。

## 冷恢复、协议和规模门禁

从根目录运行 `pnpm qa:layers` 验证已有协议快照、回放、历史数据、KAP/ACP 共有行为及客户端分页预算。[分层检查工作流](../.github/workflows/layered-qa.yml)仅手动触发，在 Linux、macOS 和 Windows 上运行。冷恢复用例对 `tests/scenarios/fixtures/released-*` 下的每份语料各跑一遍，新增的语料目录自动纳入；每份都是一个已发布 CLI 写出的原始格式，例如 [2.6.3](scenarios/fixtures/released-2.6.3/README.md)。新版本用 `pnpm qa:capture-released <版本>` 生成：它从 npm 下载已发布的包，核对 integrity，在离线环境里跑出同一轮对话，再生成新目录。已入库的语料不再改写，完整性检查会核对清单里的每个文件和摘要。宿主报告回合结束时，持久化写入可能还在进行，所以冷恢复先等续写回合的 `turn.ended` 写进 wire，再强杀进程。

- [协议字段检查](../packages/kap-server/test/apiSurface.test.ts)重新读取真实服务的 OpenAPI 和 AsyncAPI，与[入库文档](../packages/kap-server/schema/)比较。评审时看 [contract.txt](../packages/kap-server/schema/contract.txt)：一行一个字段，带类型、约束和默认值，多处共用的结构只列一次。有差异时，检查会列出每个变化，并按方向分成破坏、非破坏和未分类三类，例如请求新增必填字段属于破坏，响应新增字段属于非破坏；默认值变了归为未分类，由人判断不传该字段的客户端会不会受影响。测试宿主版本固定以隔离包版本变更，KAP 协议版本取实际值。显式更新用 `pnpm qa:refresh schema`，它同时重写两份文档和摘要。同一文件还用契约哈希钉住 `HOST_API_LEVEL`：字段、操作或消息变化后哈希改变，测试失败，由人判断新客户端连接旧版远程宿主是否会出错，需要时升级级别，再更新文件里的哈希；只改描述不影响哈希。内部调试路由不属于契约，单独列出。[契约工具](../packages/testkit/src/contract/)
- [能力表](scenarios/capabilities/conversation.json)登记 KAP 与 ACP 实际公布的能力，以及两边共有的行为场景：首轮回答、回合中取消、拒绝写文件。[对照入口](../packages/acp-server/test/kap-parity.test.ts)把每个场景用两种协议各跑一遍，结果先换成同一套词，例如 KAP 的 `interrupted` 和 ACP 的 `cancelled` 都记为取消，再分别与场景的期望比较。已知分歧写进 `divergences` 并附原因，这条场景改为断言分歧仍在；两边都符合期望后它会失败，提醒删掉条目。公布的每项能力都要出现在某个场景里，或在 `exempt` 里写明原因；能力增减而表没跟上时，守卫用例失败。
- 客户端分页用 240 个会话回合，验证并发加载每个旧页只读一次。另用 `pnpm qa:history-perf` 在 Electron 测 240 条界面消息（120 轮问答），以 1280×900 窗口比较全量渲染和窗口化渲染。全量基线应挂载 240 条，窗口化初始和滚动挂载均以 32 条为上限。同一工作流在 macos-15 上对交替顺序的三对样本比较打开耗时和 JS 堆增长中位数，并保留环境与原始数据。同一提交的相对预算可以检出窗口化失效；跨版本共同变慢需要对照留存的历史产物，定时运行的产物保留 90 天。

## 改动行的变异测试

`pnpm qa:mutation` 检验「这次改动的代码出错时，有没有测试会发现」。它只看与 `origin/main` 分叉点之后、已经提交的改动（`--base` 可换比较对象），并且只看各包 `src` 下、所在包有 Vitest 配置的 TS/JS 源文件，测试文件除外。脚本在系统临时目录另建一个 git worktree，离线安装依赖后逐个包运行 Stryker，只跑引用了被改文件的测试，当前工作区不会被改动。存活的变异体、没有相关测试覆盖的行，以及没能运行的包和原因，写进 `.tmp/mutation/summary.md`，同目录还有每个包的 HTML 报告。模块级常量这类静态变异体要重跑整包测试，默认跳过，加 `--include-static` 才会测。加 `--budget-minutes` 可以给整次运行设一个时间上限，超时没跑完的包会在摘要里注明。

启停系统进程的文件不做变异，也就是调用了 `child_process`、`process.kill`、`killProcessTree` 或 `TestProcess.start` 的文件，摘要里会写明原因。

- **为什么跳过**：变异体去掉进程号守卫后，验证这个守卫的测试会把 SIGKILL 发给自己所在的进程组，甚至当前用户的所有进程，在 CI 上就表现为 runner 失联。改坏清理逻辑的变异体则会让子进程一直泄漏。
- **兜底**：脚本还让 Stryker 单独占一个进程组；运行期间清理已经脱离进程树的残留进程，结束后再清一遍。

结果是评审信息，不是门禁。[变异测试工作流](../.github/workflows/mutation.yml)只在改动包源码、并且打了 `mutation` 标签的 PR 上运行，每次最多跑 30 分钟。摘要写进任务摘要，它也不是必过检查。Stryker 在单个 worker 线程里跑 Vitest，改 `HOME`、工作目录这类进程级状态的测试在那里会失败；这样的包在变异前就停下，摘要里列出失败的用例。
