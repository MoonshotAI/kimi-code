# os：harness-core vs agent-core-v2 差异对比

## 对应关系

- harness-core：`packages/harness-core/src/features/os/`（约 5782 行：ts 5677 + 5 份工具 md 105；含 host/ 端口与 node-local 实现、host/execEnv 五件、rg/ 两件、tools/{bash,glob,grep,read,write}、path-access.ts、process-exec.ts、output-accumulator.ts、file-type.ts、text/ 三件、configSections.ts、feature.ts）
- agent-core-v2：`src/agent/tools/os/`（3141 行，含 5 份 md）+ `src/os/`（1550 行宿主抽象与 node-local 后端）+ `src/tool/path-access.ts`（319）+ `src/tool/output-accumulator.ts`（91）+ `src/_base/execEnv/`（835），合计约 5936 行；另有 `src/agent/task/`（约 3757 行任务服务）承载 v2 Bash 前台/后台任务生命周期，不属本域蓝本但与 Bash 后台语义强相关（其替代物为 task 域 #23，见各自 diff）
- 蓝本关系：顺序表 #28，不是 refact-237 第一批 human 蓝本；以 v2 上述五个位置为直接移植蓝本，2026-09-29 九条决策定稿（Handoff 约束问答「Q: os 工具组（#28）怎么落地？」），第 18 轮分 5 批次落地，提交 `mzqrxwmo 1af2eed9`

## 行为差异

### 人为设计

| 差异点 | v2 行为 | harness-core 行为 | 依据 |
| --- | --- | --- | --- |
| 形态与注册 | 五工具各自 `registerAgentToolService`（DI、Agent scope、OnDemand、`domain:'os/backends'`），经 toolActivationService 动态上下线 | 单个 `createOs({workDir, host?, additionalDirs?, spillDir?})` 复合 Feature（`features/os/feature.ts:33`），app slot 注册两个 config 节 + `useReady(host.environment.ready)` 门控，agent slot `useAgentTools` 一次注册五工具；不进 preset（example/app.ts:69 显式挂载） | 决策①（九条，2026-09-29）；edit/shellCommand 先例 |
| 能力门控 | `requiredRuntimeCapabilities`（Bash `['process']`、Glob/Grep `['fs','process']`、Write `['fs']`，toolContribution.ts:21），`runtime.isAvailable` 不满足时工具不下线注册（toolActivationService.ts:92-95）；execute 内 `runtime.acquire([...])` + generation 校验（失败文案 `Runtime changed before execution. Retry the tool call.`） | 全部不迁。「宿主注入什么端口即能力」；无 lease、无 generation 校验、无远程 runtime 概念 | 决策①（v2 远程 runtime 场景不迁，满足 execute 传输无关约束） |
| 宿主抽象 | 三 DI 接口分离：`IHostProcessService`/`IHostFileSystem`/`IHostEnvironment`（App scope 注册），另含 IHostClock、session/terminal | 收敛为单 props 端口 `OsHost {process, fs, environment}`（host/types.ts:7-11），node-local 实现 `createNodeOsHost()` 随包提供（host/node.ts:478） | 决策② |
| 进程流模型 | `IHostProcess` 的 stdin/stdout/stderr 为 node `Readable`/`Writable`，绑死 Node 流 | stdin `{write,end}`、stdout/stderr `AsyncIterable<Uint8Array>`（types.ts:20-34），传输无关，远程宿主（浏览器/ACP）可实现同端口 | 决策①、第 18 轮①；feature-acp `createAcpOsHost`（第 36 轮）为远程实现实证 |
| rg 基础设施 | 双份拷贝：`os/backends/node-local/tools/{rgLocator,runRg}` + `workspace/workspaceFs/internal/{rgLocator,runRg}`（workspaceFs 搜索自用）；含 `vendor` source 死分支（rgLocator.ts:140-142）；选项名 `allowCachedFallback` | 单份 `features/os/rg/{locate,run}`；workspaceFs 那份不迁；vendor 死分支不搬；`allowCachedFallback` 改名 `allowDownload`；脱钩 IHostProcessService 改 `OsProcessPort`；CDN bootstrap 保留（rg 15.0.0、6 平台 SHA-256 钉死、tar/yauzl、区域解析走 oauth 包、`rgUnavailableMessage` 逐字） | 决策③、第 18 轮偏差⑤ |
| Bash 后台门控 | `allowBackground()` = TaskList/TaskOutput/TaskStop 三工具均激活（bashTool.ts:110-116）；不激活时描述经 `withoutBackgroundDescription` 四段改写、`run_in_background` 拒绝（`Background execution is not available for this agent because TaskOutput and TaskStop are not enabled.`） | `run_in_background` 恒可用；描述 md 按「后台可用」静态渲染，仅 `autoBackgroundOnTimeout=false` 一个改写分支（bash.ts:70-75）；task_id 语义 = `toolCall.id` | 决策④；用户 2026-09-27「后台不需要 task——task 就是历史上所有 detached 的 tools」（Handoff line 48） |
| Bash 后台实现通路 | 每次 Bash（含前台）都 `tasks.registerTask(new ProcessTask(...))` 进 IAgentTaskService（bashTool.ts:231-243）；前台等 `waitForForegroundRelease`；完成经 task 服务 `notifyAgentTask` 发 XML 结构化通知（`renderNotificationXml`，含 type/title/body/severity）+ 上一会话失联任务 reminder | 后台 = 框架 detach：`run_in_background` 立即 `detach(ack)`、前台超时/用户操作也走 detach（bash.ts:391-414 `doDetach`）；agent-core 机器后台 scope 续跑，完成发 `[async tool completed] Bash (tool_call_id=...)` 纯文本 user 通知（agent.ts:202-218），`tool.detached`/`tool.done{outcome}` 事件供 task 域（#23）记录 | 决策④；第 26 轮 tool.done 统一；第 50 轮 `tool.detached` 载荷携 toolCall |
| 前台 Bash 的任务化 | 前台 Bash 也是 task：>50K 时 `tasks.persistOutput`，结果附结构化 `spill{outputPath,totalChars,suffix}`（含 `task_id`/`output_size_bytes`，allowBackground 时附 `next_step: Use TaskOutput(task_id=...)`，bashTool.ts:351-375）；前台任务在背景面板可见（`onForegroundTaskStart`） | 前台 Bash 不建 task 记录；>50K 自 spill 落盘 `spillDir/bash-<toolCallId>.txt`，结果内联 `task_id`/`output_size_bytes`/`next_step: ... Use Read with path="..."` 指针（bash.ts:477-491）；`spillDir` 默认 `$KIMI_CODE_HOME/tool-results`（feature.ts:44-46） | 决策④⑤、第 18 轮偏差①（TaskOutput 属 #23，spill next_step 改 Read 指针） |
| 输出治理 | 双层：工具内 accumulator（结构化 `{isError,output,brief?,spill?}`）+ 执行器级 `IAgentToolResultTruncationService`（50K 截断、head 4096/tail 1024 预览、2000/行整形、spill 落盘；Read `spillExempt`） | 本域只做工具内自治：accumulator 退化为纯文本拼接（50K 触发/10M 保留，output-accumulator.ts）；执行器级 truncateForModel 单列议题另行归属 | 决策⑤、第 18 轮偏差① |
| 规则匹配与审批声明 | 五工具 `resolveExecution` 均产 `accesses`/`display`/`approvalRule`/`matchesRule`（rule-match：literalRulePattern/matchesGlobRuleSubject/matchesPathRuleSubject） | 全部不迁；规则匹配由 permission 域（#19）按工具名维护参数匹配器 | 决策⑥「rule-match 留 #19」；permission 设计要点「v2 的 execution.display 不迁」 |
| Read 附件与事件日志分支 | `isDaemonFileUrl(path)` → `attachmentExecution`（ISessionMediaStore + `withAttachmentLocation`，readTool.ts:241-254）；`isWireJournalPath` → 状态块加 `Kimi Code agent event log: read one record at a time...` 行（readTool.ts:469-471） | 首版跳过：无 kimi-file:// 分支、无 eventLog 状态行；但参数描述仍保留 kimi-file:// 字样（read.ts:603，md 与 v2 逐字节一致所致） | 决策⑦（依赖 media #25，docs 标注、media 落地时补） |
| shellCommand 超时语义 | v2 `!` 命令 120s 超时转后台 + 注入通知（task 服务承载） | 第 16 轮的 kill 语义修订为按 v2 接回：`shellCommand/runner.ts` 与 Bash 共享 `process-exec`，120s 超时返 `backgrounded:true` + `shell-command:<id>:backgrounded` remind（ack 文本与 Bash 同构，task_id=commandId），后台完成补发 `shell.completed` 事件（v2 后台路径不发，为 UI 生命周期闭合的有意补充）；**不走框架 detach 通路**（facade 级后台） | 决策⑧、第 18 轮④与偏差③；「shellCommand 不走 detach 通路」仍列为待用户定夺（Handoff 下一步） |
| `'task'` 节 Bash 字段 | v2 `'task'` 节含 `bashAutoBackgroundOnTimeout`（默认 true）/`bashTaskTimeoutS`（zod min 0，默认 600s）等 8 字段 + legacy `'background'` 节合并 | 两字段随 os 域注册为自己的 `'bash'` 节，字段改名 `autoBackgroundOnTimeout`/`backgroundTaskTimeoutS`（configSections.ts:22-47），env `KIMI_CODE_BACKGROUND_BASH_TASK_TIMEOUT_S` 同名保留 + stripEnv；`'task'` 节整体及其余字段留 #23（第 23 轮核查结论：不注册节） | 决策⑨、第 18 轮⑤ |
| createOs 的 host 缺省 | —（v2 无此概念，DI 总有 node-local 后端） | `host?: OsHost` 缺省 `createNodeOsHost()`（feature.ts:34），与「host 未注入即无能力」横切约定不一致；第 22 轮追加决策仅修 agentsMdReminder，createOs/createEdit/createShellCommand 的缺省创建「用户未要求改动，记录在案」 | Handoff 第 22 轮追加（line 263）记录在案 |
| Bash ack 标题行 | `backgroundStartedResult` 的 `title` 是死参数，输出无标题行 | timeout_detached / detached_by_user 两场景 ack 顶部带标题行（`Command timed out and moved to background` / `Task moved to background by the user`，bash.ts:100-125） | 第 18 轮偏差① |
| plan guard 双键 | v2 plan guard 拦 Write/Edit 的 `path` 参数 | 双键（file_path/path）保留不收敛 | 第 18 轮偏差④（零成本兼容） |

### 简化 / 保真度损失

| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
| --- | --- | --- | --- |
| Bash/! 命令的 SIGKILL 升级 | task 服务统一 SIGTERM → `killGracePeriodMs`（默认 5s，`'task'` 节可配）→ `forceStop()` SIGKILL（taskService.ts:643-666；ProcessTask.forceStop 实现于 process-task.ts:88-96） | **已修复（2026-09-30）**：`process-exec.ts` 的 abort 路径现在 SIGTERM → `sigtermGraceMs` 宽限（默认 `SIGTERM_GRACE_MS` 5s，与 rg/run.ts 惯例一致）→ `forceStop()` SIGKILL；修复前 `forceStop` 全 src 无调用方（与 Handoff 设计要点「SIGTERM→5s→SIGKILL」记录不符），os.test.ts 新增 trap-SIGTERM 升级案锁定 | 修复前忽视 SIGTERM 的进程（如 trap 住的脚本）会使前台 Bash 永久悬挂、后台任务永不完结 |
| 执行器级结果截断 | `toolResultTruncationService`（370 行）：>50K 截断 + 头 4096/尾 1024 预览 + 2000/行整形 + spill 落盘指针；Glob/Grep 结果受此保护 | 无等价物；Glob 显示行预算 10M、Grep accumulator 保留上限 10M，50K–10M 之间的结果全文进 history | 超大搜索结果直接撑上下文；归属：执行器级 truncateForModel 单列议题（决策⑤、第 18 轮遗留；2026-09-28 完整性核查「v2 下线前需归属」） |
| 错误渲染通道 | 执行器渲染层统一加 `<system>ERROR: Tool execution failed.</system>` 前缀（toolResultRender.ts）；空输出渲染 `<system>Tool output is empty.</system>` | 已切回：五工具错误返回标 `isError: true`（Bash 非零退出码同样在 v2 语义下标记），框架装配层经 `renderToolResultForModel` 统一渲染；Read 空输出仍内联 TOOL_EMPTY_STATUS（预算记账需要） | A 步已落地（第 76 轮） |
| Read 状态块 44 字符记账差 | 状态块预算经 `renderToolResultForModel` 记账，含 ERROR 包装层 44 字符 | 差异按设计保留：v2 在工具内用 renderToolResultForModel 连包装层一起记账；新架构包装层在请求装配时追加（工具预算外），极限分支（单行碎片/零行恢复）放行阈值仍略宽 | 极限分页场景模型可见字符略多于 v2；A 步落地后不自然消解，属架构性差异 | 第 18 轮偏差⑦ |
| Read 的 kimi-file:// 与 wire 日志提示未回补 | 附件分支可读 kimi-file:// 引用；wire.jsonl 有专用提示行 | 代码无分支；kimi-file:// 路径按普通相对路径解析后报 `does not exist`，**与参数描述宣称的能力不一致**；media（#25）第 38 轮已落地，本回补未发生——与 Handoff 决策⑦「media 落地时补」的预期不符 | kimi-file:// 附件经 Read 不可用（可用 ReadMediaFile 代偿）；归属：media 域后续轮次回补 |
| 前台任务面板可见性 | 前台 Bash 经 `onForegroundTaskStart` 上报，背景面板可见可操作前台任务 | 仅 `BashPendingDetach` pending map 记录可手动 detach 的前台执行（bash.ts:139-146、447-449）；无面板事件流（新架构面板只能经 `tool.detached`/task 域看到后台项） | 面板看不到前台 Bash；归属：宿主如需可消费 BashRef + 框架事件自建 |
| 遥测 | `glob_tool_rg_fallback`、`grep_tool_rg_fallback` 埋点 | 不迁 | rg 回落/下载失败不可观测；归属：遥测批次待补（横切约定，telemetry 域接线时统一处理） |
| 进程 spawn 选项面 | `HostProcessOptions` 含 `shell`/`detached`/`timeout`（hostProcess.ts:8-16；`shell` 被 externalHooks 等消费，`timeout` 在 node-local 实现中是死字段）；kill 接受任意 `NodeJS.Signals` | `OsSpawnOptions` 仅 `cwd/env/mergeStderr/windowsHide`，detached 恒 `!win32`；kill 收窄为 `'SIGTERM' \| 'SIGKILL'` | 需要 shell 语义的消费方须显式包装（externalHooks 第 44 轮 `/bin/sh -c`/`cmd.exe /s /c` 先例）；如需扩展按 `OsFsPort.rename` 端口扩展先例追加 |
| IHostClock / terminal 未迁 | `IHostClock`（dateChangeService 消费）、`session/terminal` PTY 会话（kap-server REST 消费） | OsHost 无 clock/terminal 端口 | dateChange 域自理时钟；terminal 经用户 2026-09-28 决定不做（Handoff line 57） |
| skill roots 动态并入 | Read/Write/Glob/Grep 的 additionalDirs 每次执行动态并入 `skillCatalog.getSkillRoots()`；path-access 另有 `extendWorkspaceWithSkillRoots`/`assertPathAllowed` 助手 | additionalDirs 仅来自 `createOs` props（静态）；两个助手删除（diff 可见） | 相对路径访问 skill 根目录会被 path-access 拒（须用绝对路径）；归属：需要时由宿主经 props 传入 |
| config 驱动的描述刷新 | 描述 getter 每次求值读 config/toolPolicy（重注册即刷新） | spec freeze：描述在挂载时冻结（ Bash 的 SHELL_NAME/autoBackgroundOnTimeout 改写、Read 的 DEFAULT_MAX_CHARS/MAX_CHARS 变量）；运行期 config 变化只影响 execute 内 `limits()`/`autoBackgroundOnTimeout()`/`backgroundTaskTimeoutS()` 的实时读取，描述文本需 remount 更新 | config 热改后工具描述中的数值陈旧（行为本身实时生效）；属横切「spec freeze、v2 动态重注册不迁」的既定取舍 |
| `'background'` legacy 节合并 | `resolveAgentTaskConfig` 合并 legacy `'background'` 节 | 不迁 | 老配置文件中的 `[background]` 不再生效；第 2 轮文件兼容差异先例 |
| `bashTaskTimeoutS` 允许 0 | zod `min(0)` + `parseNonNegativeInt` | `backgroundTaskTimeoutS` 正整数（schema + env parse 均要求 >0） | 0 的极端语义（超时立即转后台后即刻按 0s 再武装）不可表达；影响可忽略 |

### 新增 / 更强

| 差异点 | 说明 |
| --- | --- |
| `OsFsPort.rename` | v2 `IHostFileSystem` 13 方法无 rename；harness-core 14 方法，第 42 轮为 tower 落地做的端口扩展（host/node.ts:394-400） |
| OsHost 成为跨域共享宿主端口 | v2 三接口仅经 runtime 抽象被工具层间接消费；harness-core OsHost 被 shellCommand、edit（path-access 接收口）、tower、media、skill、sessionInit、agentsMdReminder、swarm、plugin、mcp（client-stdio 传输）等十余处复用，是「能力归宿主注入」约定的载体 |
| `BashRef` facade（`BashPendingDetach`） | v2 无对应物（v2 由 kap-server REST 直操作 task 服务）；harness-core `useExpose(BashRef, bash.pending)`（feature.ts:66）暴露 `running()`/`detach(toolCallId)`，供宿主把前台 Bash 手动转后台（产出 `detached_by_user: true` ack）。当前包内无生产消费方（仅测试），属预留接线点 |
| `useReady(host.environment.ready)` 挂载门控 | v2 工具在 resolveExecution 用 `{...env, ready: Promise.resolve()}` 绕过 ready；harness-core app slot 显式门控，修复 spec freeze 在注册时读 Bash 描述 `${SHELL_NAME}` 而 environment 未 ready 抛错的真实接线 bug（第 18 轮⑤）；ready 失败（如 Windows 缺 Git Bash → `shell.git_bash_not_found`）在挂载期即暴露 |
| 传输无关进程/文件端口 | 使远程宿主可实现同端口：feature-acp `createAcpOsHost({connection, local?})` 已实现 fs 反向 RPC + process 走 ACP terminal/create 轮询的远程 OsHost（第 36 轮）；v2 `IHostProcess` 绑死 node 流无法跨进程 |

## 可配置项差异

| 配置项 | v2 | harness-core | 分类 |
| --- | --- | --- | --- |
| `read` 节 `defaultMaxChars`/`maxChars` | zod 两字段正整数可选，defaultValue `{}`（configSection.ts） | 同 schema、同节名、同默认值（configSections.ts:7-18）；缺席回落 100000/500000 | 已对齐 |
| Bash 自动转后台开关 | `[task] bashAutoBackgroundOnTimeout`，默认 true | `[bash] autoBackgroundOnTimeout`，默认 true（节+字段改名，toml 不兼容） | 人为设计（决策⑨） |
| Bash 后台超时时长 | `[task] bashTaskTimeoutS`，zod min 0，默认 600 | `[bash] backgroundTaskTimeoutS`，正整数，默认 600 | 人为设计（决策⑨）；0 边缘收窄属简化 |
| env `KIMI_CODE_BACKGROUND_BASH_TASK_TIMEOUT_S` | 绑定 `bashTaskTimeoutS`，parse 非负整数 | 同名绑定 `backgroundTaskTimeoutS`，parse 正整数；stripEnv 写回剥离 | 已对齐（parse 微调） |
| `'task'` 节其余字段 | `maxRunningTasks`/`keepAliveOnExit`/`killGracePeriodMs`/`printWaitCeilingS`/`printBackgroundMode`/`printMaxTurns` + 5 个 `KIMI_CODE_BACKGROUND_*` env | 不注册（第 23 轮核查：属 v2 任务服务/宿主运行时；其中 killGracePeriodMs 的承载机制本身也未迁，见 SIGKILL 升级缺口） | 人为设计 |
| legacy `'background'` 节 | 与 `'task'` 节合并读取（task/configSection.ts 的 `LEGACY_BACKGROUND_SECTION`） | 不迁（Handoff 未单列，随决策⑨「'task' 节整体留 #23」自然失效；第 23 轮核查亦未注册） | 简化 / 保真度损失 |
| `workDir` | `ISessionWorkspaceContext`（会话工作区上下文） | 工厂 prop `createOs({workDir})` | 人为设计（宿主注入） |
| `additionalDirs` | workspaceCtx + skill roots 动态并入 | 工厂 prop（静态） | 人为设计（注入点变化）+ skill roots 动态并入未迁（简化） |
| 宿主能力 | DI runtime（node-local/standalone/remote） | 工厂 prop `host?: OsHost`，缺省 `createNodeOsHost()` | 人为设计（决策②；缺省创建记录在案） |
| spill 目录 | 任务服务输出目录 | 工厂 prop `spillDir?`，默认 `$KIMI_CODE_HOME/tool-results` | 人为设计 |
| `KIMI_CODE_HOME` | rg shareDir 与任务输出共用 | rg shareDir 与 spillDir 默认共用 | 已对齐 |
| 阈值常量 | 工具结果 50K 触发 spill / 10M 保留、rg 20s/10MB/5s 升级、bash 60/300/600/86400s、read 100000/500000/10MB、grep 250 行/500 列、glob 100 条 | 全部逐字对齐（bash.ts:18-21、run.ts:3-5、read.ts:22-25、grep.ts:28-29、glob.ts:28、output-accumulator.ts:1-3） | 已对齐 |
| 工具描述 md | 五份 md + renderPrompt 变量（SHELL_NAME、四档超时、read 两档字符） | 五份 md 与 v2 逐字节一致（cmp 复核）；renderPrompt 变量集相同；Glob 的 WINDOWS_PATH_HINT 按 pathClass 拼接一致 | 已对齐 |

## 工具 / 事件 / facade 面差异

- 工具清单：Bash / Glob / Grep / Read / Write 五工具同名、参数名一致（满足 btw 白名单 `Read/Grep/Glob`、plan guard 拦 `Write/Edit` 的 `path`、spawn catalog 名单三处既有引用硬约束）。v2 侧的 TaskList/TaskOutput/TaskStop 不属本域，由 task 域（#23）另行落地；bash.md 中 TaskOutput/TaskStop 字样刻意保留（第 18 轮偏差②，#23 落地后语义自洽）。
- 参数 schema：v2 为 zod + `toInputJSONSchema`（draft-7，io:input，自动补 `additionalProperties:false`）；harness-core 为手写 JSON Schema，字段、类型、描述文案、required、additionalProperties 逐字对齐。v2 Bash `timeout` 带 zod `.default(60)`（io:input 下不进 schema，运行时默认由各自代码归一，行为一致）；超时上限校验 v2 在 zod superRefine、harness-core 在 execute 内，报错文案 `timeout must be ≤ Ns (foreground|background)` 逐字一致。各工具另有 `invalid <Tool> arguments: <raw>` 参数容错解析（wait-for 先例），v2 由 zod 报错路径承载，文案不同。
- 结果契约：v2 `ExecutableToolResult` 含 `isError/output/note/brief/spill/truncated/spillExempt` 结构化字段；harness-core `ToolResult` 现在有 `isError` 通道（第 76 轮框架通道，note/brief/spill/truncated 等其余结构化字段仍无）。v2 的 `note`（Read 状态块独立通道）在 harness-core 内联进文本尾部，内容逐字一致。
- Feature 事件：两侧均无自有事件。v2 的任务事件（TaskNotified 等）属任务服务；harness-core 的 Bash 后台生命周期由框架 `tool.detached`/`tool.done{outcome}` + task 域 `task.*` 事件表达。
- facade：harness-core `BashRef`（见上表）；v2 仅有 DI decorator（`IBashTool` 等），无对外 facade。

## 摘要

总体对齐程度高：五工具的名称、参数、描述 md（逐字节）、输出/警告/状态块文案、全部阈值常量、path-access 敏感文件策略、rg 定位/下载/运行语义均逐字对齐；execEnv 五件与 md 经 cmp 复核逐字节一致。最重要的三个差异：① Bash 后台从 v2 任务服务（ProcessTask + XML 通知 + 前台任务化）整体改道框架 detach + `[async tool *]` 文本通知 + task 域记录，task_id=toolCall.id（决策④，用户 2026-09-27 后台语义重定义的直接后果）；② 结果契约结构化通道大幅退化——isError 通道已落地（第 76 轮），spill 改 Read 指针与 note 内联等其余退化仍在；③ v2 的 runtime 能力门控/lease/generation 校验不迁，能力决策完全归宿主端口注入（决策①②）。最需关注的缺口：执行器级结果截断未归属（50K–10M 结果全文进上下文）与 Read 的 kimi-file:// 分支在 media 落地后仍未回补（参数描述与实现不一致）。~~Bash 进程执行器缺 SIGTERM→SIGKILL 升级~~ 已于 2026-09-30 修复（`process-exec.ts` abort 路径武装 SIGTERM→`sigtermGraceMs`（默认 5s）→`forceStop()` SIGKILL，含 trap-SIGTERM 测试案）。
