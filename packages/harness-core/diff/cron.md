# cron：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/cron/`（约 1371 行 ts + 3 份 md；`feature.ts` 373 行为去 Service 化摊平形态）
- agent-core-v2：`packages/agent-core-v2/src/features/cron/`（约 1700 行 ts + 3 份 md；`cronService.ts` 555 行 + DI 工具类）
- 蓝本关系：迁移顺序表 #17，以 v2 DI 版实现为行为规格蓝本（非 refact-237 第一批 human 蓝本）；第 17 轮实现、第 29 轮去 Service 化摊平（行为零变化）、第 31 轮 squash 入 cron 功能提交。

## 行为差异

### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| fire 投递与 steer 竞态 | tick 先查 loop 空闲，`deliverFire` 以 `submit(…, { steerIfActive: true })` 投递——**空闲检查与 submit 之间的竞态会 steer 注入活跃 turn 中途**；`buffered` 标志进遥测 | `agent.submit` 裸投递（无 steer）——同一竞态下落为**排队**，当前 turn 结束后才触发；`runTick` 同样先查 `snapshot.matches('running')` 跳过 | 第 17 轮记录在案：「steer 竞态路径不迁，更合『绝不注入 turn 中途』契约」 |
| 任务 id 形态 | ULID（`ulid()`，`CRON_ID_REGEX` 兼容 8-hex 短 id 与 26 位 Crockford）；CronDelete 校验 ULID 形态，文案 `must be a ULID.`，md/schema 描述均为 ULID | `randomUUID()`；CronDelete 校验 UUID 形态，文案 `must be a UUID.`，md/schema 描述同步改 UUID（3 份 md 与该描述是全部 md 差异） | 第 17 轮记录在案：「id 用 randomUUID，CronDelete 校验改 UUID 形态」 |
| tick 串行化 | actor 邮箱事件（`cron.tick` → sendTo effects）+ `inFlight` 集合防 per-task 重入 | promise 链串行化（`chain.then(runTick)`），tick 永不重叠，`inFlight` 不需要 | 第 17 轮偏差②「tick 用 promise 链串行化（替代 v2 actor 邮箱）」 |
| 配置 schema 形态 | `cron` 节为 passthrough cast（`value as CronConfig`，不校验、未知键保留、缺字段运行时落 undefined 后走默认分支） | zod 字段级 default（`debug/noJitter/noStale/disabled/manualTick` 默认 false，`clock` optional，`pollIntervalMs` int≥0 nullable），未知键 strip | 第 17 轮偏差②「配置 schema 用 zod 字段级 default（v2 passthrough，可观察行为一致）」 |
| v2 死代码不迁 | facade 含 `handleMissed`（`cron_missed` origin 提交 + 遥测）、`getNextFireTime()`、`emitScheduled`/`emitDeleted`（仅遥测包装）——v2 src 内均无消费方（grep 实证，仅 cronService 自身与类型声明引用） | 均未迁 | 第 17 轮记录在案 |
| 错误体系 | `cron-expr.ts` 抛 `Error2(CRON_EXPRESSION_INVALID, …, {details})`（错误域注册） | 同文件抛裸 `Error`/`TypeError`，**全部文案逐字一致**（diff 实证仅错误类型与 details 差异） | coded error 范式（sessionExport 第 20 轮偏差⑤先例：Error2 域注册机制不迁） |
| 进 preset / 可见性 | `registerFeature` 默认启用集；subagent 经 profile 工具白名单默认不可见 cron 工具 | 进 preset（`createCron()`）；feature 池共享使 subagent 可见三工具、execute 期拒绝（`CRON_MAIN_AGENT_ONLY` 文案两侧逐字一致） | 第 17 轮编排者决定④「可见性差异已知，执行期门控语义等价」 |
| 调度器挂载门控 | effects 仅 main agent 启动（`agentId !== MAIN_AGENT_ID` 直接 return） | 定时器/SIGUSR1 接线仅 main（`agentId === MAIN_AGENT_ID` 块内），三工具对所有 agent 注册 | 已对齐（结构差属架构形态，行为等价） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| 遥测 | `cron_scheduled`（工具侧 `emitScheduled`）、`cron_fired {recurring, coalesced_count, stale, buffered}`、`cron_deleted`（stale 自删与工具侧 `emitDeleted`）、`cron_missed` 四事件 | 无（`buffered` 标志随 steer 路径一并消失） | 遥测不迁批次（第 24 轮 telemetry builtin 落地后逐域补回，goal 同批） |
| isError 结果通道 | 全部校验失败（disabled/表达式非法/5 年无 fire/超 50 上限/prompt 超 8KiB/one-shot 超一年/id 形态错/未找到）回 `{isError:true, output}`，模型经 ERROR 状态块感知 | 已切回（校验失败标 `isError: true`，框架渲染） | A 步已落地（第 76 轮） |
| approvalRule | CronCreate 经 `literalRulePattern` 生成含完整 JSON 参数的规则模式；CronDelete/CronList 用工具名规则 | `ToolDefinition` 无 approvalRule 面（permission 域内按工具名维护参数匹配器，第 29 轮机制） | rule-match 归属 permission 域（第 18 轮决策⑥同类）；cron 工具的细粒度规则匹配待 permission 域按名承接 |
| 校验时机 | `resolveExecution` 期完成全部校验（审批/执行前即拒），execute 内仅复查 50 上限 | 全部校验在 execute 内（若有审批交互，无效输入会先经过审批才被拒绝） | 通道差异的连带结果；无单独在案 |
| fork 继承语义 | 代码事实：全量 session fork 复制 wire journal（含 cron durable 事件）→ **任务继承**，`'forked'` marker 仅 goal 消费；turnIndex 截断 fork 防御性删 `agents/<id>/cron` 目录（`sessionLifecycleService.ts:824`）；agent fork（btw/spawn 子代理）全新事件流 → 不继承 | 投影沿 branch parent 链回放 → fork 后任务记录**继承**（非 main 无调度器，惰性残留；主代理 session fork 场景任务继续生效） | 第 17 轮遗留「cron 的 fork 继承语义待用户定夺」在案；注意 Handoff 括注「v2 fork 删 cron 目录」仅对截断 fork 成立，全量 fork 实为继承——**与 Handoff 表述有出入，按代码写** |
| durable 事件校验 | `CronAdd`/`CronDelete`/`CronCursor` 带 zod schema（读取时校验） | 投影直接 `as` cast（`projection.ts:15-24`），无校验 | 内部健壮性差异（goal 投影是防御性读取，cron 未做同款），无行为影响 |
| config ready 屏障 | tick 前 `await config.ready`；restore 后待 config ready 再 arm 一次定时器 | 无 ready 屏障：挂载即按当前（可能默认）配置 arm，配置后到时经 watch re-arm 收敛 | 与「watch re-arm」同源（见新增表）；首 tick 窗口内可能按默认值跑，影响可忽略 |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| `CronFace.tasks: ShallowRef<CronState>` | 响应式任务表直读（v2 只能 `list()` 快照或轮询） |
| 配置 watch 响应式 re-arm | `watch(section)` 即时重设定时器/SIGUSR1——v2 仅 restore 后 arm 一次，运行期改 `cron` 节不生效；harness 运行期改配置即生效（第 17 轮偏差②在案） |
| `addTask`/`removeTasks` await 落账 | store dispatch await 保证 CronCreate→CronList 即时一致；v2 为 `void dispatch` fire-and-forget（第 17 轮偏差②在案） |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| `cron.debug` / env `KIMI_CRON_DEBUG`（parse `'1'`） | ✓ | ✓ | 已对齐 |
| `cron.noJitter` / env `KIMI_CRON_NO_JITTER` | ✓ | ✓ | 已对齐 |
| `cron.noStale` / env `KIMI_CRON_NO_STALE` | ✓ | ✓ | 已对齐 |
| `cron.disabled` / env `KIMI_DISABLE_CRON` | ✓ | ✓ | 已对齐（工具侧拒绝文案 `Cron scheduling is disabled (KIMI_DISABLE_CRON=1).` 逐字一致） |
| `cron.manualTick` / env `KIMI_CRON_MANUAL_TICK`（非 win32 SIGUSR1） | ✓ | ✓ | 已对齐 |
| `cron.clock` / env `KIMI_CRON_CLOCK`（`system`/`file:<path>` 文件钟） | ✓ | ✓ | 已对齐（`internal/clock.ts` 两側逐字节一致；v2 `?? SYSTEM_CLOCKS` 为不可达兜底，harness 省略等价） |
| `cron.pollIntervalMs` / env `KIMI_CRON_POLL_INTERVAL_MS`（`'null'` 字面量禁轮询、0 禁、缺省 1000ms） | ✓ | ✓ | 已对齐 |
| stripEnv | ✓ | ✓ | 已对齐 |
| 节注册方式 | 模块 import 时 `registerConfigSection` 全局注册 | app slot `useConfigSection(cronConfigSection)` 贡献注册；agent slot `providerRef(ConfigRef)` 可选探测，config 缺席走 `DEFAULT_CRON_CONFIG` | 已对齐（config 缺席回落默认值横切约定） |
| experimental flag | 无 | 无 | 已对齐 |
| 工厂 props | 无（DI 服务） | `createCron()` 无 props | 已对齐 |

## 工具 / 事件 / facade 面差异
- **工具清单**：`CronCreate`/`CronList`/`CronDelete` 三件同名；3 份 md 仅 ULID→UUID 措辞差（cmp 实证其余逐字节）；参数 zod schema 同款（含 50 条/会话、8KiB prompt、5 年无 fire 拒建、one-shot 超一年拒建全部阈值与文案）；输出主路径逐字一致（`id/cron/humanSchedule/recurring/nextFireAt` 行序、CronList 记录格式含 `previewPrompt` 200 字节 UTF-8 安全截断、`ageDays` 两位小数、`stale` 标志、`Deleted cron job <id>.`/`No cron job with id <id>.` 文案）。
- **工具契约差异**：id 形态（ULID→UUID）；isError 已对齐（其余两项 approvalRule、校验时机见行为表）。
- **Feature 事件**：`cron.fired` 类型串一致、payload `{origin, prompt}` 同形；v2 为 observable Event2 总线事件，harness 为 Feature 节点事件（`useFire`）。`CronJobOrigin` 形状两侧逐字一致（`kind/jobId/cron/recurring/coalescedCount/stale`），`renderCronFireXml` 同一实现（`format.ts` 仅 import 来源差）。
- **durable 事件**：`cron.add`/`cron.delete`/`cron.cursor` 类型串两侧一致；v2 zod schema，harness 无校验 cast（见行为表）。重启恢复、coalesce 合并漏发（`MAX_COALESCE_ITERATIONS=10_000` 同值）、一次性自删、stale ≥7 天（`STALE_THRESHOLD_MS` 同值）最后一投后自删全部对齐。
- **内部件**：`internal/clock.ts`、`internal/jitter.ts` 逐字节一致；`internal/cron-expr.ts` 仅错误类型差（Error2→Error，文案逐字）；`internal/format.ts` 仅 import 差。
- **facade**：v2 `IAgentCronService` 14 方法 vs harness `CronFace` 11 方法 + `tasks` ref；对齐 `now/isDisabled/addTask/removeTasks/getTask/list/isStale/getNextFireForTask/computeDisplayNextFire/tick`；未迁 `getNextFireTime/handleMissed/emitScheduled/emitDeleted`（死代码/遥测，在案）；新增 `tasks`。v2 `tick()` 在 restore 前 reject `'Cron runtime is not restored'`，harness `tick()` 随时可跑（空状态即空转），差异可忽略。

## 摘要
对齐度很高：调度循环（1s 轮询/SIGUSR1/文件钟/jitter）、coalesce 与 stale 生命周期、durable 事件形态、三工具契约与输出文案逐字对齐，config 节七字段与 env 绑定全对齐。最重要的三个差异：① **steer 竞态不迁**（人为设计——fire 绝不注入 turn 中途，竞态落为排队）；② **id 形态 ULID→UUID**（在案，md/schema/校验同步改写）；③ 遥测/approvalRule 两通道未迁（isError 已随 A 步落地）。最需关注的缺口：**fork 继承语义仍未定夺**（第 17 轮遗留在案；代码事实是 v2 全量 session fork 继承任务、截断 fork 删 cron 目录、agent fork 不继承，harness 一律沿分支继承且非 main 惰性）——session fork 后同一任务可能在两个会话并行 fire，需尽快裁决。
