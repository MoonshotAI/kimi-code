# 教程:迁移你的第一个消费方

日期:2026-09-19。代码基线:`ccf3d5d6`(main 上删除 v1 的 #3542 的直接父提交)。此时 v1 `@moonshot-ai/agent-core` 0.15.8、v2 `@moonshot-ai/agent-core-v2` 0.4.3、`@moonshot-ai/kimi-code-sdk` 0.20.0 并存;本文所有路径与符号均以该基线逐条核对。文中路径一律从仓库根写起。本文是 [`migration-from-v1.zh-CN.md`](../../migration-from-v1.zh-CN.md) 的子文档;英文原版:[`first-consumer-migration.md`](first-consumer-migration.md)。

本教程假定你第一次接触 v2。你维护一个依赖 `@moonshot-ai/agent-core`(v1)的消费方——直接依赖或经 `@moonshot-ai/kimi-code-sdk`——现在迁移最小闭环:**读配置 → 建 session → 发 prompt → 收事件 → 关闭**。读完你会有一个能跑的 v2 消费方,以及一份这个闭环里埋着的坑的清单。

## 1. 先说好消息:对外公开面不变

如果你的消费方经 `@moonshot-ai/kimi-code-sdk` 与引擎打交道,公开面在两个引擎下完全同形。三层证据:

1. **`KimiHarness`**(`packages/node-sdk/src/kimi-harness.ts:82`)—— 两个工厂都返回同一个类:
   - `createKimiHarness(options): KimiHarness`(`packages/node-sdk/src/sdk-rpc-client.ts:145`)
   - `createKimiHarnessV2(options): KimiHarness`(`packages/node-sdk/src/sdk-rpc-client-v2.ts:2732`)
   - 两者入参都是同一个 `KimiHarnessOptions`(`packages/node-sdk/src/types.ts:165-175`)。
2. **`Session`**(`packages/node-sdk/src/session.ts:82`)—— `harness.createSession()/resumeSession()` 返回同一 `Session` 类,与引擎无关(`kimi-harness.ts:140-164, 205-226`)。
3. **`SDKRpcClientBase`**(`packages/node-sdk/src/rpc.ts:183`)—— `SDKRpcClient`(v1,`sdk-rpc-client.ts:48`)与 `SDKRpcClientV2`(`sdk-rpc-client-v2.ts:374`)都继承它;它从 `packages/node-sdk/src/index.ts:20` 公开导出。

基类承载共享方法面(按域分组,括号内为定义行号;v2 均有对应 `override`,除注明外):

- **会话生命周期**:`createSession`(199)、`createSessionWithKaos`(206)、`resumeSession`(216)、`resumeSessionWithKaos`(221)、`reloadSession`(231)、`forkSession`(239)、`closeSession`(250)、`deleteSession`(255)、`listSessions`(260)、`listSessionsPage`(275)、`renameSession`(299)、`generateSessionTitle`(311,v1 抛 `not_implemented`)、`exportSession`(319)、`updateSessionMetadata`(667)、`addAdditionalDir`(599)、`listWorkspaceSkills`(280)、`suggestFiles`(866,v1 返回 `undefined`)、`getWorkspaceTrustInfo`/`trustWorkspace`(290/295,v1 恒 trusted/no-op)。
- **配置**:`getConfig`(331)、`getConfigDiagnostics`(336)、`setConfig`(346)、`removeProvider`(351)、`supportsAtomicSectionReplace`(361,v1 false)、`replaceConfigSections`(372,v1 抛)、`getExperimentalFeatures`(341)。
- **文件**:`uploadFile`/`deleteFile`(385/392,v1 抛 `not_implemented`)。
- **prompt / turn**:`prompt`(531)、`promptWithSkills`(546,v1 抛)、`steer`(579)、`runShellCommand`(554)、`cancelShellCommand`(569)、`cancel`(613)、`swarm`(696)、`setSwarmMode`(691)、`setTowerMode`(701,v1 抛)、`generateAgentsMd`(589)、`getSessionWarnings`(594)、`startBtw`(604)、`activateSkill`(1060)、`activatePluginCommand`(1070)、`listCommands`/`runCommand`(1088/1093,v1 空数组/抛)、`getRuntime`/`switchRuntime`(1101/1106,v1 抛)。
- **状态读取**:`setModel`(640)、`setThinking`(649)、`setPermission`(658)、`setPlanMode`(677)、`getPlan`(728)、`clearPlan`(736)、`compact`(744)、`cancelCompaction`(753)、`undoHistory`(769)、`clearContext`(622)、`importContext`(630)、`getContext`(778)、`getUsage`(786)、`getStatus`(794)、`getTodos`(761,v1 抛)、`listSkills`(842)。
- **goal / cron / 后台任务**:`createGoal`/`getGoal`/`pauseGoal`/`resumeGoal`/`cancelGoal`(929-966)、`getCronTasks`(968)、`listBackgroundTasks`(872)、`getBackgroundTaskOutput`(884)、`stopBackgroundTask`(896)、`detachBackgroundTask`(908)、`waitForBackgroundTasksOnPrint`(919)、`handlePrintMainTurnCompleted`(924)。
- **MCP**:`listGlobalMcpServers` 等管理面 17 个方法(399-529)、`listMcpServers`(973)、`listWorkspaceMcpServers`(984,v1 空数组)、`getMcpStartupMetrics`(989)、`reconnectMcpServer`(994)、`addSessionMcpServer`(1008)。
- **插件**:`listPlugins`/`installPlugin`/`setPluginEnabled`/`setPluginMcpServerEnabled`/`removePlugin`/`reloadPlugins`/`getPluginInfo`(1021-1058)、`listPluginCommands`(847)、`listPluginCommandsGlobal`(857,v1 空数组)。
- **事件与回调(引擎无关,基类自带注册表,两客户端都不 override)**:`onEvent`(1111)、`receiveEvent`(1118)、`setApprovalHandler`(1124)、`setQuestionHandler`(1132)、`clearSessionHandlers`(1140)、`requestApproval`(1145)、`requestQuestion`(1172)、`toolCall`(1191)、`withInteractiveAgent`/`interactiveAgentId`(189-195)。

机械核对结果:v2 共 **106 个 `override`**;基类方法中 v2 未覆盖的只有:上述事件/handler 注册表方法(引擎无关)+ `createSessionWithKaos`/`resumeSessionWithKaos`(有意保留基类降级,见 §4 坑 #5)。v1 的 `SDKRpcClient` 只 override 了这两个 kaos 变体(`sdk-rpc-client.ts:115,125`),其余全部走基类 → `getRpc()` → v1 RPC。

两客户端各自的公有字段/方法(构造面):

| 成员 | v1 `SDKRpcClient` | v2 `SDKRpcClientV2` |
|---|---|---|
| 字段 | `homeDir/configPath/identity/telemetry/auth/core`(`sdk-rpc-client.ts:49-54`) | `homeDir/configPath/identity/telemetry/auth/klient`(`sdk-rpc-client-v2.ts:375-380`) |
| Options 类型 | `SDKRpcClientOptions`(32-46,多 `resolveOAuthTokenProvider`) | `SDKRpcClientV2Options`(351-365) |
| `ensureConfigFile()` | 92-94 | 499-508 |
| `close()` | 96-109 | 510-535 |
| v2 新增公开面 | — | `engineAccessor` getter(608)、`suppressEngineSessionStarted()`(578)、`enabledExperimentalFlags()`(591)、`listCapabilities`/`getCapability`/`installCapability`(880-890) |

**结论性事实**:基类未覆盖方法在 v2 上不会静默走错路——`SDKRpcClientV2.getRpc()` 直接抛 `KimiError(ErrorCodes.NOT_IMPLEMENTED, 'This SDK method is not wired to agent-core-v2 yet.')`(`sdk-rpc-client-v2.ts:612-617`);v2 文件头注释(1-136 行)明确定义了迁移模型「基类承载 v1 方法面,未 override 者响亮失败」。

## 2. 最小闭环:v1 与 v2 写法对照

### 2.1 消费方视角骨架(v1 与 v2 的唯一差别是第一行)

仓库内已有完全对应的真实示例 `packages/node-sdk/examples/kimi-harness-prompt-demo.ts`(v1 写法,137 行),骨架即取自它:

```ts
// v1:import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';
// v2:仅换工厂函数(同一包、同一类型):
import { createKimiHarnessV2 as createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

const harness = createKimiHarness({ identity, homeDir });        // ① 建 harness
const config = await harness.getConfig();                        // ② 读配置
const model = config.defaultModel;
const session = await harness.createSession({ workDir, model }); // ③ 建 session
const unsubscribe = session.onEvent((event) => {                 // ④ 订事件
  if (event.type === 'turn.ended') { /* turn 结束 */ }
  if (event.type === 'assistant.delta') { /* 流式输出 */ }
});
await session.prompt('Hello');                                   // ⑤ 发 prompt
await session.close();                                           // ⑥ 关 session
await harness.close();                                           // ⑦ 关 harness
```

每一行对应的真实签名:

- 工厂:`createKimiHarness`(`sdk-rpc-client.ts:145-159`)/ `createKimiHarnessV2`(`sdk-rpc-client-v2.ts:2732-2756`),入参 `KimiHarnessOptions`(`types.ts:165-175`)。
- `harness.getConfig()`(`kimi-harness.ts:434-436`)。
- `harness.createSession(options)`(`kimi-harness.ts:140-164`),`CreateSessionOptions`(`types.ts:177-207`,必填仅 `workDir`)。
- `session.onEvent(listener)`(`session.ts:122-129`,内部按 `event.sessionId === this.id` 过滤后返回 `Unsubscribe`);事件 union 类型从 `packages/node-sdk/src/events.ts:9` 导出(`Event` 来自 v1 协议)。
- `session.prompt(input)`(`session.ts:141-151`;`promptId` 选项仅 v2 生效,见 §4 坑 #7)。
- `session.close()`(`session.ts:744-753`)、`harness.close()`(`kimi-harness.ts:631-634`)。
- 事件等待的惯用法见示例 `kimi-harness-prompt-demo.ts:37-56`(等 `turn.ended` + `error` 拒绝 + 超时);测试内同款 helper `waitForSDKEvent`(`packages/node-sdk/test/session-runtime-helpers.ts:54-73`)。

真实消费方切换范例(CLI):`apps/kimi-code/src/cli/run-shell.ts:87-90` —— `isKimiV2Enabled()` 决定 `createKimiHarnessV2(harnessOptions)` 还是 `createKimiHarness(harnessOptions)`,同一份 `harnessOptions`。开关定义在 `apps/kimi-code/src/cli/experimental-v2.ts`:`KIMI_CODE_LEGACY_FLAG` truthy 时走 v1,默认 v2(14、31-35 行)。

### 2.2 底层调用序列对照(「引擎换了什么」)

| 步骤 | v1 路径 | v2 路径 |
|---|---|---|
| 构造 | `new SDKRpcClient`:`createRPC<CoreAPI,SDKAPI>()` + 进程内 `new KimiCore(...)`(`sdk-rpc-client.ts:77-89`) | `new SDKRpcClientV2`:`bootstrap({homeDir, configPath, clientIdentity, args})` + `createKlient({scope: app})` 走 memory transport(`sdk-rpc-client-v2.ts:451-469`) |
| 读配置 | 基类 `getConfig` → `rpc.getKimiConfig`(`rpc.ts:331-334`) | `await this.configReady` → `klient.global.config.getAll()` → `resolvedConfigToKimiConfig` 纯映射(`sdk-rpc-client-v2.ts:745-751`;`v2/config-mapper.ts:56-65`) |
| 建 session | 基类 `createSession` → `rpc.createSession`(`rpc.ts:199-204`) | `ISessionManager.create({sessionId, workDir, additionalDirs})` + `wireSession(handle)`;`model/thinking/permission` 触发主 agent 物化与 profile 绑定(`sdk-rpc-client-v2.ts:1320-1370`) |
| 发 prompt | 基类 `prompt` → `rpc.prompt({sessionId, agentId, input})`,`agentId` 取自 AsyncLocalStorage(`rpc.ts:531-539`) | `klient.session(id).agent(id).prompt(...)`,先经 `agentFacade` 确保主 agent 已物化(`sdk-rpc-client-v2.ts:1971-1978`, 1724-1727) |
| 收事件 | v1 引擎经 RPC 回调 `ClientAPI.emitEvent` → `receiveEvent`(`rpc.ts:1200-1205`) | `SessionEventWiring` 订阅每个 agent 的 `IEventBus`,`translateDomainEvent` 补 `sessionId/agentId` 戳后喂给同一个 `receiveEvent`(`v2/session-wiring.ts:153-166`;`v2/event-mapper.ts:65-79`) |
| 关闭 | `core.shutdown()` + logger flush,异常吞掉(`sdk-rpc-client.ts:96-109`) | wiring/subscription dispose → `klient.close()` → `ISessionIndexMirror.drain()` → `IMcpOAuthService.shutdown()` → `app.dispose()` + 三个 drain(`sdk-rpc-client-v2.ts:510-535`) |

补充事实:v2 引擎在进程内 bootstrap,但所有 facade 调用都经过 klient memory transport 的契约校验与 JSON 往返(`sdk-rpc-client-v2.ts` 头注释 1-7 行;`createKlient` 来自 `@moonshot-ai/klient/memory`,248 行)。

## 3. 测试基建

### 3.1 vitest alias 指到包源码

- `packages/node-sdk/vitest.config.ts:5-21`:`resolve.alias` 把 `@moonshot-ai/agent-core` → `../agent-core/src/index.ts`、`@moonshot-ai/kimi-code-oauth` → `../oauth/src/index.ts`;`test.name: 'kimi-sdk'`,env `KIMI_LOG_LEVEL: 'off'`,`include: ['test/**/*.test.ts']`。
- **为什么只需 alias 这两个**:其余包的 `exports` 本来就指源码——`@moonshot-ai/kimi-code-sdk` 自身 `"."` → `./src/index.ts`(`packages/node-sdk/package.json:32-37`)、`@moonshot-ai/agent-core-v2` `"."` 与 `"./*"` → `./src/*.ts`、`@moonshot-ai/klient`(含 `/memory`、`/ipc` 子路径)同样指 `./src/*.ts`(各包 package.json)。所以 monorepo 内消费方(如 `apps/kimi-code/vitest.config.ts`)只 alias 自己的 `@` → `src`,不需要包 alias。
- alias 的副作用(教程提醒):`v2/session-mapper.ts:24-29` 与 `v2/resume-replay.ts:77-79` 注释说明——alias 到包 index 会吞掉深子路径导入,因此 `normalizeWorkDir` 在 SDK 内做了逐字节复制、in-memory persistence 也是本地实现。

### 3.2 不起真引擎的 fake / in-memory 后端

仓库内**没有独立的 fake 引擎包**;两种既有模式:

1. **Stub 基类(不起任何引擎)**:`SDKRpcClientBase` 是公开导出(`index.ts:20`),测试直接子类化:
   - `packages/node-sdk/test/kimi-harness.test.ts:24-40`:`class StubRpc extends SDKRpcClientBase`,`getRpc()` 抛 `'no core calls expected'`;`makeHarnessWithRpc` 演示如何用最小 options 手工 `new KimiHarness(rpc, {...})`。
   - 同款:`test/create-session-transport.test.ts:71`、`test/session-prompt-input.test.ts:7`(`CapturingRpc`)、`test/mcp-config.test.ts:759`(`OAuthRpc`)。
   - 基类自带 `onEvent`/`receiveEvent`/approval/question 注册表(`rpc.ts:1111-1196`),stub 里调 `receiveEvent(fakeEvent)` 即可注入事件——这是消费方单测最轻的路径。
2. **真引擎 + 临时 home(不起 provider)**:仓库的集成测试模式是把 `KIMI_CODE_HOME` 指向 `mkdtemp`,不触网:
   - `packages/node-sdk/test/v1-v2-parity.test.ts:537-543`(`makeParityPair`):同一 fixture home 上同时 `createKimiHarness` + `createKimiHarnessV2` —— 这正是「迁移正确性」的仓库级验证方式,测试头注释(1-11 行)写明「no provider calls」。
   - `packages/node-sdk/test/sdk-rpc-client-v2.test.ts:99-103`(`makeHarness`,只建 v2)。
   - 配套工具:`test/test-identity.ts`(固定 `KimiHostIdentity`)、`test/telemetry.ts`(`recordingTelemetry` 内存遥测)、`test/session-runtime-helpers.ts`(`makeTempDir`/`removeTempDirs`/`waitForSDKEvent`/读 `wire.jsonl` 的 helper)。
   - v2 引擎 close 后临时目录删除要与异步 drain 赛跑:`sdk-rpc-client-v2.test.ts:79-87` afterEach 先 `drainSessionIndexMirror()` + `drainQueryStoreDisposals()` 再 `rm`(ENOTEMPTY 教训,亦见 `sdk-rpc-client-v2.ts:519-534` 注释)。
3. **`@moonshot-ai/klient/memory` transport 不是 fake**:`createKlient({scope})` 仍 bootstrap 真 v2 引擎,只是 transport 在进程内(`sdk-rpc-client-v2.ts:248,469`)。不要把它当成 mock。

## 4. 迁移坑清单(全部出自 `src/v2/*` 与 v2 客户端注释/实现)

1. **时间格式 epoch ↔ ISO、时间来源也变了**:
   - v2 `SessionMeta` 存 epoch-ms、字段名 `createdAt/updatedAt`;v1 `SessionMeta` 存 ISO 字符串。转换在 `v2MetaToSessionMeta`:`new Date(meta.createdAt).toISOString()`(`packages/node-sdk/src/v2/session-mapper.ts:68-71`,头注释 8-9 行)。
   - `SessionSummary` 级的时间戳不做格式转换、直接透传 v2 index 值(`session-mapper.ts:54-55`),但两引擎**来源不同**:v1 读 session 目录的 fs birth/mtime,v2 读 metadata 戳——parity 测试因此对 `createdAt/updatedAt` 不做比较(`test/v1-v2-parity.test.ts` KNOWN_DIFFS 注释,243-253 行)。
2. **`workDir` ↔ `cwd`**:v2 `SessionMeta.cwd` ↔ v1 `SessionMeta.workDir`(`session-mapper.ts:76`);list 场景的 workDir 来自 `item.cwd ?? workspace.root`(`sdk-rpc-client-v2.ts:1282`)。归一化必须逐字节等于 v1:`normalizeWorkDir`(`session-mapper.ts:30-35`)是 v1 `agent-core/session/store/workdir-key` 的镜像;空 workDir 在 v2 侧复刻 v1 的拒绝 `REQUEST_WORK_DIR_REQUIRED`(`sdk-rpc-client-v2.ts:2759-2764`)。
3. **事件戳 `sessionId`/`agentId`**:v2 总线是 per-agent 的,事件本身不带这两个字段;SDK 在 `translateDomainEvent(event, sessionId, agentId)` 里补戳(`v2/event-mapper.ts:65-79`,头注释 5-9 行;调用点 `v2/session-wiring.ts:155-164`)。同层还有:v2-only 类型被丢弃清单(`event-mapper.ts:31-44`,含 `prompt.*`、`agent.activity.updated`、`permission.approval.*` 等)、`task.started/terminated` 改回 v1 拼写 `background.task.*`(52-55)、`turn.started` 剥掉内部字段 `promptAttachments`(72-77)、进程全局总线只有 `session.meta.updated` 被转发(89-95;`sdk-rpc-client-v2.ts:477-486`)、`agent.status.updated` 在边缘补 usage/context/model 快照(`session-wiring.ts:283-311`)。
4. **`KimiError` 形状保持**:v2 引擎抛 `Error2`,SDK 公开契约是 `KimiError`(`isKimiError` 可分支,从 `index.ts:47-58` 再导出)。桥接点:
   - MCP 管理面统一 `restateMcpManagementError`:Error2 → 同 code/message/details 的 `KimiError`;未声明的新 code 降级为 `internal`(否则 `toKimiErrorPayload` 序列化会炸)(`sdk-rpc-client-v2.ts:2766-2784`)。
   - `sessionNotFound` 逐字段复刻 v1 形状(`SESSION_NOT_FOUND` + `details.sessionId`,997-1001);`deleteSession` 捕获引擎 not-found 后重述(1460-1478)。
   - `getRpc()` 兜底抛 `KimiError(NOT_IMPLEMENTED)`(612-617)。
   - 非 Error2 的失败(DI 解析 bug、abort)原样透传(2770-2771 注释)。
5. **kaos 注入点消失**:v1 `SDKRpcClient.createSessionWithKaos/resumeSessionWithKaos` 真把 kaos 接进 core(`sdk-rpc-client.ts:115-134`);v2 引擎没有注入点,有意保留基类降级——**静默忽略 kaos 实参**跑本地 create/resume(`sdk-rpc-client-v2.ts` 头注释 131-135 行 + session-lifecycle 节头 924-932 行;基类实现 `rpc.ts:206-229`)。传了自定义 kaos 的消费方迁移后行为会静默变化。
6. **ready trap(读配置的时序)**:v2 引擎的 config/model/provider 读是同步的、底层状态要等初始 load;v2 客户端构造时抓 `configReady`(`IConfigService.ready`)与 `modelReady`(config+model+provider 三者)(`sdk-rpc-client-v2.ts:383-408`),每个 config/agent 覆写方法先 await。`ensureConfigFile()` 在 Windows 还要等 `IHostEnvironment.ready`(Git Bash 探测)(499-508)。直接用 `engineAccessor` 逃逸舱的消费方必须自己守这个时序。
7. **`promptId` 仅 v2 生效**:`SessionPromptRpcInput.promptId` 文档明确「Honored by the v2 RPC client only」(`rpc.ts:91-96`);v1 收到也忽略。
8. **prompt 入队语义差异(已钉在迁移追踪)**:v1 在 turn 进行中收到 prompt 会丢弃(只发 error 事件),v2 FIFO 排队(`sdk-rpc-client-v2.ts:1967-1970` 注释)。
9. **`getContext().tokenCount` 语义差异**:v1 报运行中估计值,v2 报 provider 实测前缀(首个 LLM 轮次前为 0)(`sdk-rpc-client-v2.ts:1796-1804` 注释);`importContext` 后 v1 会把估计值采纳为报告值、v2 无公开 setter,读后即发散(1932-1936 注释;KNOWN_DIFFS `getContext`,`v1-v2-parity.test.ts:274-285`)。
10. **标题默认值**:v1 store 把 `'New Session'` 物化进 state.json 并报告;v2 不留默认标题(KNOWN_DIFFS,`v1-v2-parity.test.ts:243-253`)。fork 默认标题两边不同:v1 "New Session" vs v2 "Fork: <source>"(`sdk-rpc-client-v2.ts:1415-1417` 注释)。
11. **live 会话约束**:`updateSessionMetadata` 两边都只服务 live 会话(v1 走 live session 404 于关闭会话;v2 用 `requireLiveSession` 镜像)(`sdk-rpc-client-v2.ts:1578-1588`);多数 agent 交互方法同样要求 live(session-lifecycle 注释 1650-1663)。
12. **会话目录/持久化布局不同**:v2 每 agent 一本 `wire.jsonl`(`<sessionDir>/agents/<agentId>/wire.jsonl`),replay 折叠复用 v1 恢复管线(`v2/resume-replay.ts` 头注释 1-54);`exportSession` 的 zip 条目清单明确**不在** parity 面内(`sdk-rpc-client-v2.ts:1621-1623` 注释)。直接读目录的消费方(如 `examples/kimi-harness-smoke.ts:28-48` 写 `state.json`/`wire.jsonl` 的玩法)不能平移。
13. **插件 hook 事件并集差**:v2 引擎的 hook 事件 union 是 v1 超集;`getPluginInfo` 投影时丢弃 v1 不认识的 hook 事件(`sdk-rpc-client-v2.ts:855-872`)。
14. **v2-only 能力的失败形状要预先知道**:`generateSessionTitle`、`promptWithSkills`、`setTowerMode`、`getTodos`、`uploadFile`/`deleteFile`、`replaceConfigSections`、`runCommand`、`getRuntime`/`switchRuntime` 在 v1 客户端上抛 `KimiError(NOT_IMPLEMENTED)`(基类 `rpc.ts:311-317, 372-397, 546-552, 701-707, 761-767, 1093-1109`);能力面用 `capabilityRpc` 结构探测,v1 上抛 `TypeError('...requires v2')`(`session.ts:70-80`)。消费方做双引擎兼容时要 catch 这些。
15. **关闭顺序**:v2 `close()` 必须按序 drain(mirror → OAuth shutdown → dispose → 三个全局 drain),否则宿主删 homeDir 会撞 ENOTEMPTY(`sdk-rpc-client-v2.ts:510-535`;测试侧 afterEach 同款,`sdk-rpc-client-v2.test.ts:79-87`)。

## 5. 如何验证迁移

1. **parity 对照**:在同一 fixture home 上用两个引擎各跑一遍你的流程——仓库的现成模式是 `makeParityPair`(`packages/node-sdk/test/v1-v2-parity.test.ts:537-543`),并排起 `createKimiHarness` 与 `createKimiHarnessV2`,不触网。比的是可观察行为,不是内部实现;已接受的差异钉在该文件的 KNOWN_DIFFS(191-368 行;覆盖范围 caveat 见下方待核)。
2. **v1 引用清零**:`rg "@moonshot-ai/agent-core"` 在你的包内零命中(注意排除 `agent-core-v2` 前缀误匹配),构建与 typecheck 通过。
3. **真实数据**:用真实 session 目录起一遍 v2,确认 journal 迁移、replay 重建、配置读取一致(读路径的行为见 [`../reference/wire-and-data.zh-CN.md`](../reference/wire-and-data.zh-CN.md))。
4. **事件流**:用 §2 的闭环确认仍能收到 `assistant.delta` / `turn.ended`(它们由 SDK 的 event-mapper 补 `sessionId`/`agentId` 戳),且错误以 `KimiError` 而非 `Error2` 出现。

## 待核清单

1. **`KimiHarnessOptions.autoLoadConfig` 疑似死选项**:声明于 `types.ts:169`,全 `src/` 无任何引用(两个客户端、KimiHarness 都不读)。是否在 daemon-client 宿主侧(本包外)被消费——未核。
2. **`CreateSessionOptions.agentProfile/agentFiles`(`types.ts:192-197`)与 `ResumeSessionInput.agentProfile`(228)v2 静默丢弃**:v1 基类把 `coreInput` 原样转给引擎(`rpc.ts:199-204`);v2 `doCreateSession` 只转 `{sessionId, workDir, additionalDirs}`(`sdk-rpc-client-v2.ts:1343-1347`),resume 只转 `additionalDirs`(1496-1499);`kimi-harness.ts:181` 的 `agentProfile !== undefined` 分支对 v2 等于空调用。是否已钉在迁移追踪文档——未核(v2 客户端 createSession 注释 1306-1319 未提及)。
3. **`SessionSummary.createdAt/updatedAt` 在 v1 线上的精确格式**(ISO 还是 epoch):§4 坑 #1 只确认了「来源不同、parity 不比较」与 meta 层 epoch→ISO 转换;v1 `SessionSummary` 类型声明本身未翻(在 `agent-core` 的 session/store 里)。要写死格式需补这一条。
4. **KNOWN_DIFFS 全量清单**:`test/v1-v2-parity.test.ts:191-368` 只核读了前 ~180 行(flag/config/plugin/session/resume/context/plan/status/goal/background/MCP 各条),剩余段(339-368 及 2010 行之后的调用点)未逐条展开;若教程要附录全量已知差异表,需要再读该文件 340-460 行段。
5. **基线后漂移(待核)**:v1 侧引用 `packages/node-sdk/src/sdk-rpc-client.ts`、`packages/node-sdk/test/kimi-harness.test.ts`、`packages/node-sdk/test/v1-v2-parity.test.ts`、`apps/kimi-code/src/cli/experimental-v2.ts` 已在声明基线 `ccf3d5d6` 核实;在当前工作区检出(#3542 之后的 main)中它们已不存在——随 v1 一并删除(#3542,即 remove agent-core v1 工作项,该工作项同时把 `createKimiHarnessV2` 改名 `createKimiHarness` 作为唯一工厂)。教程中 v1 侧行号仍是基线事实;删除后的承接物待核。
