# notify：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/notify/`（214 行 ts + 15 行 md：feature.ts 78 / nudge.ts 85 / tool.ts 48 / index.ts 3）
- agent-core-v2：`src/features/notify/`（383 行 ts + 15 行 md：notifyFeature.ts 23 / sessionNotify.ts 66 / notifyUserNudgeService.ts 110 / notifyUserNudge.ts 89 / notifyUserAvailability.ts 11 / flag.ts 16 / tools/notify-user 68）
- 蓝本关系：以 v2 DI 版为蓝本（第 17 轮迁移，nudge 五纯函数与两渲染逐字移植、notify-user.md 逐字节）。非 refact-237 第一批域。

## 行为差异
### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 宿主投递通道 | 工具只回执文本；宿主（TUI）经 wire `tool.call.started` 观察 NotifyUser 调用的 message 参数展示到 Updates 面板 | execute 内 `useFire` 发 `notify.shown { message }` Feature 事件，宿主订阅该事件投递（tool.ts:44） | 第 17 轮：新架构 AgentEmitted 无 tool.call.started，宿主投递必须经 Feature 事件 |
| availability 判定 | `notifyUserAvailable(flags, bootstrap)` = flag `notify_user` 开启 + bootstrap `uiCapabilities` 含 `update_panel`（notifyUserAvailability.ts:8-10） | props `available?: () => boolean`，缺省读 `KIMI_CODE_EXPERIMENTAL_NOTIFY_USER` / `KIMI_CODE_EXPERIMENTAL_FLAG` env；`update_panel` 宿主能力折入该端口 | 第 17 轮（宿主能力折入 available 端口）；flag 门控域不进 preset（验收标准「flag 门控域不进 preset、文档写明开关」） |
| 工具/guidance/nudge 门控时机 | Feature `contributeTool(..., { when: ISessionNotify.enabled })` 动态门 + session 级持久化 enabled（`state.json`，首载回退扫描 wire journal 的 profile.bind systemPrompt 是否含 guidance 文案） | 挂载时 `available()` 为假则不贡献工具/不叠 guidance/不注册 nudge（feature.ts:47）；spec.frozen 使恢复一致 | 第 17 轮：spec freeze 语义下挂载期决策；「v2 会话级持久化扫描不迁」记录在案 |
| guidance 注入 | profile 渲染变量 `${notify_user_guidance}`（profile-shared.ts:120/150，`notifyUserActive` 时拼入 system.md） | `useSystemPrompt({ id: 'notify', text: NOTIFY_USER_GUIDANCE })`，文案逐字 | 第 17 轮 |
| nudge 机制 | reminder 总线 `register('notify_user_nudge')`，注入期再查 flag + 工具注册表；`lastInjectedAt` 由总线追踪（durable 历史扫描） | `useBeforeStep` 读回调参数的 turn 活 history 计算 + `agent.remind(key='notify_user_nudge')`；`lastReminderPosition` 扫活 history | 第 17 轮偏差①：store 写链在 turn 进行中滞后，读 store 会永不触发，故读 beforeStep 活 history |
| nudge 判定/文案 | `toolCallsSinceLastNotify` / `toolCallsSincePosition` / `lastMidResponsePosition` / `shouldNudgeNotifyUser` / `shouldNudgeMidResponse` + `renderNotifyUserNudge` / `renderMidResponseHint`（阈值 8） | 五个纯函数与两渲染逐字移植（nudge.ts） | 第 17 轮（逐字声明，已核对一致） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| turn 起点判定 | `startsNewTurn` 按 origin.kind 细分：user / cron_job / cron_missed / task / retry / system_trigger（≠stop_hook）/ skill_activation（user-slash）/ plugin_command（notifyUserNudge.ts:8-27） | `startsNewTurn` 只看 `meta.source ∈ {input, notify}`（nudge.ts:7-10） | 第 17 轮偏差①已知保真度损失（v2 origin.kind 细分无新架构对应物）；遗留「待 cron 等域 origin 消费方落地后复核」 |
| 重复 nudge re-arm 节奏 | 注入即计入下一请求，'8' 后 '16' 可再触发 | remind 经 drain 下一步生效，'8' 后 '17' 才再触发（晚 1 次调用） | 第 17 轮偏差①（催促节奏与去重不变，仅 re-arm 晚一次）；机器语义，无归属 |
| session 级 enabled 持久化 | `SessionNotify`：state.json 持久化 + wire journal profile.bind 扫描回退，会话内可恢复 enabled 态 | 不迁（无对应物；available 每次挂载评估） | 第 17 轮记录在案（spec freeze 使挂载期恢复一致，持久化扫描失去必要性） |
| 空 message 错误通道 | `resolveExecution` 对空 message 回 `{ isError: true, output: 'message must not be empty.' }` | 已切回（空 message 标 `isError: true`，tool.ts） | A 步已落地（第 76 轮） |
| 工具执行元信息 | `description: 'Notifying the user'`、`ToolAccesses.none()`、`approvalRule: this.name`（notifyUserTool.ts:35-37） | 未迁 | 归属 permission 域 #19（approvalRule 面） |
| flag 配置优先级 | per-flag env > `[experimental]` config > master env > default 四级 | 仅 env / props 两级（不读 `[experimental]` config 节） | flag 体系整体不迁的已知差异（各 flag 域同）；无归属 |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| 每步重评估 available | `useBeforeStep` 内每次评估 `available()`（feature.ts:52），运行期 flag/env 翻转即时生效；v2 挂载期 `when` + nudge 注入期 flag 检查为两点评估，语义大体等价但新架构更直接 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| experimental flag | `notify_user` flag（env `KIMI_CODE_EXPERIMENTAL_NOTIFY_USER`，默认 false，surface core；另受 master env 与 `[experimental]` config） | props `available?`，缺省读 `KIMI_CODE_EXPERIMENTAL_NOTIFY_USER` / `KIMI_CODE_EXPERIMENTAL_FLAG` | 人为设计（env 名对齐；config 优先级不迁） |
| 宿主能力 | bootstrap `uiCapabilities: ['update_panel']` | 折入 props `available` | 人为设计（第 17 轮） |
| session 持久化 enabled | `state.json`（scope notify） | 无 | 简化（见上表） |
| config 节 | 无 | 无 | 已对齐 |

## 工具 / 事件 / facade 面差异
- 工具：`NotifyUser` 名称、`notify-user.md`（cmp 逐字节一致）、参数 schema（`message` string minLength 1 + describe 文案）、三文案 `Update shown to the user.` / `message must not be empty.` / `Notifications are disabled; the update was not displayed.` 逐字对齐。差异：execute 内再查 available（v2 同样执行期再查 `notifyUserAvailable`，对齐）。
- Feature 事件：v2 无 Feature 事件（投递走 wire tool.call.started）；harness-core `notify.shown { message }`（`createFeature<NotifyEvent>`）——投递通道的事件化替代。
- facade：两侧均无 facade（纯工具 + 注入域）。

## 摘要
notify 的工具契约（md、schema、三文案）、guidance 文案与 nudge 算法（五纯函数 + 两渲染 + 阈值 8）与 v2 逐字对齐，flag 门控语义以 props available 端口等价承接并不进 preset。最重要的差异是投递通道事件化（notify.shown 取代 wire tool.call.started 观察）与挂载期门控取代 v2 的 session 持久化 enabled——两者均为第 17 轮记录在案的人为设计。最大缺口是 turn 起点判定的 origin.kind 细分（cron/stop_hook 等）在 meta.source 二分法下的保真度损失，已记录待 origin 消费方落地后复核；re-arm 晚一次调用为 remind 机器语义的固有特性。
